package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.LearningResource;
import com.la.entity.ResourceProgress;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.LearningResourceMapper;
import com.la.mapper.ResourceProgressMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 学习资源：教师上传（PPT/视频/图片/Word/PDF）→ AI 识别内容并关联知识点 →
 * 学生查看并记录学习进度 → 教师查看每个学生的学习进度。
 *
 * 文件存储在运行目录 uploads/resource/ 下（jar 外，重发布不丢数据）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ResourceService {

    private final LearningResourceMapper resourceMapper;
    private final ResourceProgressMapper progressMapper;
    private final UserMapper userMapper;
    private final ResourceAiService resourceAiService;
    private final ObjectMapper objectMapper;

    /** 运行目录下的资源存储目录（本地=项目根 uploads/resource/，云端=服务器部署目录 uploads/resource/） */
    private static final Path STORE_DIR = Paths.get("uploads", "resource");

    /** 各类型允许的扩展名 */
    private static final Map<String, List<String>> EXT_BY_TYPE = Map.of(
            "ppt", List.of("ppt", "pptx"),
            "video", List.of("mp4"),
            "image", List.of("jpg", "jpeg", "png"),
            "word", List.of("doc", "docx"),
            "pdf", List.of("pdf"));

    /** 各类型大小上限（字节） */
    private static final long VIDEO_MAX = 200L * 1024 * 1024;
    private static final long OTHER_MAX = 50L * 1024 * 1024;

    /* ==================== 教师：上传 / 列表 / 删除 / 编辑知识点 ==================== */

    /**
     * 教师上传学习资源：校验格式与大小 → 流式落盘 → AI 识别（简介+知识点）→ 落库。
     * manualKpCodes：教师在弹窗中手动选择的知识点（与 AI 识别结果合并、白名单过滤）。
     */
    public Map<String, Object> upload(Long teacherId, Long classId, String title,
                                      MultipartFile file, List<String> manualKpCodes) {
        if (title == null || title.isBlank()) {
            throw new BizException("请填写资源标题");
        }
        if (title.length() > 100) {
            throw new BizException("资源标题过长（100 字以内）");
        }
        if (file == null || file.isEmpty()) {
            throw new BizException("请选择要上传的文件");
        }
        String fileName = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().trim();
        String fileType = resolveFileType(fileName);
        long size = file.getSize();
        if ("video".equals(fileType) ? size > VIDEO_MAX : size > OTHER_MAX) {
            throw new BizException("文件超过大小上限（视频 200MB，其余 50MB）");
        }

        // 流式落盘（transferTo 不在 JVM 堆内缓存整个文件，大视频不撑内存）
        try {
            Files.createDirectories(STORE_DIR);
        } catch (IOException e) {
            throw new BizException("创建存储目录失败，请联系管理员");
        }
        String storedName = System.currentTimeMillis() + "-" + Long.toHexString(Double.doubleToLongBits(Math.random()))
                + "-" + sanitizeFileName(fileName);
        Path dest = STORE_DIR.resolve(storedName);
        try {
            file.transferTo(dest);
        } catch (IOException e) {
            log.warn("[资源上传] 落盘失败：{}", e.getMessage());
            throw new BizException("文件保存失败，请重试");
        }

        try {
            // AI 识别：文本类资源生成简介 + 关联知识点；图片/视频仅标题简介
            ResourceAiService.Recognition rec = resourceAiService.recognize(title.trim(), fileType, dest);

            LearningResource r = new LearningResource();
            r.setClassId(classId);
            r.setTeacherId(teacherId);
            r.setTitle(title.trim());
            r.setFileName(fileName);
            r.setFilePath(storedName);
            r.setFileType(fileType);
            r.setFileSize(size);
            r.setKpCodes(toJson(mergeKpCodes(rec.kpCodes(), manualKpCodes)));
            r.setAiSummary(rec.summary());
            resourceMapper.insert(r);

            log.info("[资源上传] id={} type={} size={} aiKp={} title={}", r.getId(), fileType, size,
                    rec.kpCodes(), r.getTitle());
            return dto(r, null, 0);
        } catch (BizException e) {
            safeDelete(dest);
            throw e;
        } catch (Exception e) {
            safeDelete(dest);
            log.warn("[资源上传] 识别/落库失败：{}", e.getMessage());
            throw new BizException("资源处理失败，请重试");
        }
    }

    /** 教师资源列表（含每个资源已学完人数统计） */
    public List<Map<String, Object>> teacherList(Long classId) {
        List<LearningResource> list = resourceMapper.selectList(new LambdaQueryWrapper<LearningResource>()
                .eq(LearningResource::getClassId, classId)
                .orderByDesc(LearningResource::getCreatedAt));
        return list.stream().map(r -> dto(r, null, completedCount(r.getId()))).toList();
    }

    /** 删除资源：删记录 + 级联删进度 + 删磁盘文件 */
    public void delete(Long teacherId, Long resourceId) {
        LearningResource r = resourceMapper.selectById(resourceId);
        if (r == null) {
            throw new BizException("资源不存在或已被删除");
        }
        if (!r.getTeacherId().equals(teacherId)) {
            throw new BizException("只能删除自己上传的资源");
        }
        resourceMapper.deleteById(resourceId);
        progressMapper.delete(new LambdaQueryWrapper<ResourceProgress>()
                .eq(ResourceProgress::getResourceId, resourceId));
        safeDelete(STORE_DIR.resolve(r.getFilePath()));
        log.info("[资源删除] id={} title={}", resourceId, r.getTitle());
    }

    /** 教师编辑关联知识点（白名单过滤后覆盖保存） */
    public void updateKpCodes(Long teacherId, Long resourceId, List<String> kpCodes) {
        LearningResource r = resourceMapper.selectById(resourceId);
        if (r == null) {
            throw new BizException("资源不存在或已被删除");
        }
        if (!r.getTeacherId().equals(teacherId)) {
            throw new BizException("只能编辑自己上传的资源");
        }
        String joined = String.join(",", validKpCodes(kpCodes));
        LearningResource upd = new LearningResource();
        upd.setId(resourceId);
        upd.setKpCodes(toJson(joined.isBlank() ? List.of() : List.of(joined.split(","))));
        resourceMapper.updateById(upd);
    }

    /** 教师查看某学生的学习资源进度（班级学生页档案卡） */
    public Map<String, Object> studentProgress(Long studentId) {
        User stu = userMapper.selectById(studentId);
        if (stu == null || !"STUDENT".equals(stu.getRole())) {
            throw new BizException("学生不存在");
        }
        List<LearningResource> resources = stu.getClassId() == null ? List.of()
                : resourceMapper.selectList(new LambdaQueryWrapper<LearningResource>()
                .eq(LearningResource::getClassId, stu.getClassId())
                .orderByDesc(LearningResource::getCreatedAt));
        Map<Long, ResourceProgress> prog = progressMapper.selectList(new LambdaQueryWrapper<ResourceProgress>()
                        .eq(ResourceProgress::getUserId, studentId))
                .stream().collect(Collectors.toMap(ResourceProgress::getResourceId, p -> p));
        List<Map<String, Object>> items = new ArrayList<>();
        int done = 0;
        for (LearningResource r : resources) {
            ResourceProgress p = prog.get(r.getId());
            boolean completed = p != null && p.getCompleted() != null && p.getCompleted() == 1;
            if (completed) done++;
            items.add(dto(r, p, null));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", resources.size());
        out.put("completed", done);
        out.put("items", items);
        return out;
    }

    /* ==================== 学生：查看 / 进度 ==================== */

    /** 学生资源列表（本班全部资源 + 我的进度） */
    public List<Map<String, Object>> studentList(Long userId) {
        User stu = userMapper.selectById(userId);
        if (stu == null || stu.getClassId() == null) {
            return List.of();
        }
        List<LearningResource> resources = resourceMapper.selectList(new LambdaQueryWrapper<LearningResource>()
                .eq(LearningResource::getClassId, stu.getClassId())
                .orderByDesc(LearningResource::getCreatedAt));
        Map<Long, ResourceProgress> prog = progressMapper.selectList(new LambdaQueryWrapper<ResourceProgress>()
                        .eq(ResourceProgress::getUserId, userId))
                .stream().collect(Collectors.toMap(ResourceProgress::getResourceId, p -> p));
        return resources.stream().map(r -> dto(r, prog.get(r.getId()), null)).toList();
    }

    /** 学生打开资源：UPSERT 进度（首次查看记 first_viewed_at，view_count+1） */
    public Map<String, Object> markView(Long userId, Long resourceId) {
        ResourceProgress p = progressMapper.selectOne(new LambdaQueryWrapper<ResourceProgress>()
                .eq(ResourceProgress::getUserId, userId).eq(ResourceProgress::getResourceId, resourceId));
        if (p == null) {
            p = new ResourceProgress();
            p.setUserId(userId);
            p.setResourceId(resourceId);
            p.setViewCount(1);
            p.setCompleted(0);
            p.setFirstViewedAt(LocalDateTime.now());
            p.setLastViewedAt(LocalDateTime.now());
            progressMapper.insert(p);
        } else {
            ResourceProgress upd = new ResourceProgress();
            upd.setId(p.getId());
            upd.setViewCount((p.getViewCount() == null ? 0 : p.getViewCount()) + 1);
            upd.setLastViewedAt(LocalDateTime.now());
            progressMapper.updateById(upd);
        }
        return studentList(userId).stream()
                .filter(x -> resourceId.equals(x.get("id"))).findFirst().orElse(Map.of());
    }

    /** 学生标记学完 */
    public void markComplete(Long userId, Long resourceId) {
        ResourceProgress p = progressMapper.selectOne(new LambdaQueryWrapper<ResourceProgress>()
                .eq(ResourceProgress::getUserId, userId).eq(ResourceProgress::getResourceId, resourceId));
        if (p == null) {
            p = new ResourceProgress();
            p.setUserId(userId);
            p.setResourceId(resourceId);
            p.setViewCount(1);
            p.setCompleted(1);
            p.setFirstViewedAt(LocalDateTime.now());
            p.setLastViewedAt(LocalDateTime.now());
            progressMapper.insert(p);
        } else if (p.getCompleted() == null || p.getCompleted() != 1) {
            ResourceProgress upd = new ResourceProgress();
            upd.setId(p.getId());
            upd.setCompleted(1);
            upd.setLastViewedAt(LocalDateTime.now());
            progressMapper.updateById(upd);
        }
    }

    /* ==================== 文件流（预览 / 下载） ==================== */

    /** 按资源 id 读取磁盘文件（预览/下载共用；鉴权在 Controller 层） */
    public File getFile(Long resourceId) {
        LearningResource r = resourceMapper.selectById(resourceId);
        if (r == null) {
            throw new BizException("资源不存在或已被删除");
        }
        File f = STORE_DIR.resolve(r.getFilePath()).toFile();
        if (!f.isFile()) {
            throw new BizException("资源文件已丢失，请联系教师重新上传");
        }
        return f;
    }

    public LearningResource getById(Long resourceId) {
        LearningResource r = resourceMapper.selectById(resourceId);
        if (r == null) {
            throw new BizException("资源不存在或已被删除");
        }
        return r;
    }

    /** 预览/下载的 Content-Type（按扩展名） */
    public String contentType(LearningResource r) {
        String n = r.getFileName().toLowerCase();
        if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (n.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (n.endsWith(".doc")) return "application/msword";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    /** Content-Disposition 文件名（RFC 5987 UTF-8，兼容中文） */
    public String contentDisposition(String fileName, boolean inline) {
        String encoded = URLEncoder.encode(fileName, StandardCharsets.UTF_8).replace("+", "%20");
        return (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encoded;
    }

    /* ==================== 内部工具 ==================== */

    /** 根据文件名后缀判定资源类型，非法后缀抛错 */
    private String resolveFileType(String fileName) {
        int dot = fileName.lastIndexOf('.');
        String ext = dot >= 0 ? fileName.substring(dot + 1).toLowerCase() : "";
        for (Map.Entry<String, List<String>> e : EXT_BY_TYPE.entrySet()) {
            if (e.getValue().contains(ext)) {
                return e.getKey();
            }
        }
        throw new BizException("不支持的文件格式，仅支持 PPT / 视频(mp4) / 图片(jpg/png) / Word / PDF");
    }

    /** AI 识别结果与教师手动选择合并去重（手动优先在前） */
    private List<String> mergeKpCodes(List<String> aiCodes, List<String> manualCodes) {
        Set<String> merged = new LinkedHashSet<>();
        if (manualCodes != null) {
            merged.addAll(validKpCodes(manualCodes));
        }
        if (aiCodes != null) {
            merged.addAll(validKpCodes(aiCodes));
        }
        return new ArrayList<>(merged);
    }

    /** 知识点白名单过滤：仅保留系统课程体系内存在的编码 */
    private List<String> validKpCodes(List<String> codes) {
        if (codes == null || codes.isEmpty()) {
            return List.of();
        }
        List<String> cleaned = codes.stream().filter(c -> c != null && !c.isBlank()).distinct().toList();
        if (cleaned.isEmpty()) {
            return List.of();
        }
        return resourceAiService.validKpCodes(cleaned);
    }

    private String toJson(List<String> codes) {
        try {
            return codes.isEmpty() ? "[]" : objectMapper.writeValueAsString(codes);
        } catch (Exception e) {
            return "[]";
        }
    }

    /** 资源列表项解析出的编码数组 */
    static List<String> parseKpCodes(String json) {
        try {
            return new ObjectMapper().readValue(json == null || json.isBlank() ? "[]" : json,
                    new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {
                    });
        } catch (Exception e) {
            return List.of();
        }
    }

    private int completedCount(Long resourceId) {
        return progressMapper.selectCount(new LambdaQueryWrapper<ResourceProgress>()
                .eq(ResourceProgress::getResourceId, resourceId)
                .eq(ResourceProgress::getCompleted, 1)).intValue();
    }

    private void safeDelete(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (Exception ignored) {
        }
    }

    /** 存储文件名去路径分隔符，防目录穿越 */
    private String sanitizeFileName(String name) {
        String s = name.replace('\\', '_').replace('/', '_').replace("..", "_");
        return s.isBlank() ? "file" : s;
    }

    /** 统一 DTO：资源 + 我的进度（学生端）或已学完人数（教师端） */
    private Map<String, Object> dto(LearningResource r, ResourceProgress p, Integer completedCount) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.getId());
        m.put("title", r.getTitle());
        m.put("fileName", r.getFileName());
        m.put("fileType", r.getFileType());
        m.put("fileSize", r.getFileSize());
        m.put("kpCodes", parseKpCodes(r.getKpCodes()));
        m.put("aiSummary", r.getAiSummary());
        m.put("createdAt", r.getCreatedAt());
        if (p != null) {
            Map<String, Object> pr = new LinkedHashMap<>();
            pr.put("viewCount", p.getViewCount());
            pr.put("completed", p.getCompleted() != null && p.getCompleted() == 1);
            pr.put("firstViewedAt", p.getFirstViewedAt());
            pr.put("lastViewedAt", p.getLastViewedAt());
            m.put("myProgress", pr);
        } else {
            m.put("myProgress", null);
        }
        if (completedCount != null) {
            m.put("completedCount", completedCount);
        }
        return m;
    }
}
