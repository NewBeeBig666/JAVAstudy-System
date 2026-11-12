package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.la.entity.CodingProject;
import com.la.entity.ProjectVersion;
import com.la.entity.StudentProject;
import com.la.entity.User;
import com.la.entity.ClassCoTeacher;
import com.la.entity.ClassEntity;
import com.la.exception.BizException;
import com.la.mapper.CodingProjectMapper;
import com.la.mapper.ClassCoTeacherMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.ProjectVersionMapper;
import com.la.mapper.StudentProjectMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 「项目代码」板块：教师发布编程项目 / 学生创建项目并多版本留存 / 教师实时查看进度与代码
 */
@Service
@RequiredArgsConstructor
public class ProjectService {

    private final CodingProjectMapper codingProjectMapper;
    private final StudentProjectMapper studentProjectMapper;
    private final ProjectVersionMapper projectVersionMapper;
    private final UserMapper userMapper;
    private final ClassMapper classMapper;
    private final ClassCoTeacherMapper classCoTeacherMapper;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM-dd HH:mm");

    /* ==================== 教师端 ==================== */

    /** 教师可见班级（授课 ∪ 共同管理）内某班的项目列表（含参与学生数/版本数） */
    public List<Map<String, Object>> teacherProjects(Long teacherId, Long classId) {
        requireManageable(teacherId, classId);
        List<CodingProject> projects = codingProjectMapper.selectList(new LambdaQueryWrapper<CodingProject>()
                .eq(CodingProject::getClassId, classId)
                .orderByDesc(CodingProject::getUpdatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (CodingProject p : projects) {
            Map<String, Object> dto = toProjectDto(p);
            List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId()));
            dto.put("studentCount", sps.size());
            dto.put("submittedCount", sps.stream().filter(s -> "SUBMITTED".equals(s.getStatus())).count());
            dto.put("versionCount", sps.isEmpty() ? 0
                    : Optional.ofNullable(projectVersionMapper.selectCount(new LambdaQueryWrapper<ProjectVersion>()
                            .in(ProjectVersion::getStudentProjectId, sps.stream().map(StudentProject::getId).collect(Collectors.toList()))))
                    .map(Number::intValue).orElse(0));
            result.add(dto);
        }
        return result;
    }

    /** 发布项目 */
    @Transactional
    public Map<String, Object> publish(Long teacherId, Long classId, String title, String description) {
        requireManageable(teacherId, classId);
        if (title == null || title.isBlank()) {
            throw new BizException("项目标题不能为空");
        }
        if (title.length() > 120) {
            throw new BizException("项目标题不能超过 120 字");
        }
        if (description == null || description.isBlank()) {
            throw new BizException("项目需求说明不能为空");
        }
        CodingProject p = new CodingProject();
        p.setClassId(classId);
        p.setTeacherId(teacherId);
        p.setTitle(title.trim());
        p.setDescription(description.trim());
        p.setStatus("PUBLISHED");
        codingProjectMapper.insert(p);
        return toProjectDto(codingProjectMapper.selectById(p.getId()));
    }

    /** 编辑项目（不改动状态与归属） */
    @Transactional
    public Map<String, Object> update(Long teacherId, Long projectId, String title, String description) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        if (title != null && !title.isBlank()) {
            if (title.length() > 120) {
                throw new BizException("项目标题不能超过 120 字");
            }
            p.setTitle(title.trim());
        }
        if (description != null && !description.isBlank()) {
            p.setDescription(description.trim());
        }
        p.setUpdatedAt(LocalDateTime.now());
        codingProjectMapper.updateById(p);
        return toProjectDto(p);
    }

    /** 上架 / 下架状态管理 */
    @Transactional
    public Map<String, Object> changeStatus(Long teacherId, Long projectId, String status) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        if (!"PUBLISHED".equals(status) && !"OFFLINE".equals(status)) {
            throw new BizException("状态仅支持上架（PUBLISHED）/ 下架（OFFLINE）");
        }
        p.setStatus(status);
        p.setUpdatedAt(LocalDateTime.now());
        codingProjectMapper.updateById(p);
        return toProjectDto(p);
    }

    /** 删除项目（级联删除学生项目与全部版本） */
    @Transactional
    public void delete(Long teacherId, Long projectId) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, p.getId()));
        if (!sps.isEmpty()) {
            projectVersionMapper.delete(new LambdaQueryWrapper<ProjectVersion>()
                    .in(ProjectVersion::getStudentProjectId, sps.stream().map(StudentProject::getId).collect(Collectors.toList())));
            studentProjectMapper.delete(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId()));
        }
        codingProjectMapper.deleteById(p.getId());
    }

    /** 教师实时查看：项目下所有学生的完成进度（学生名/学号/状态/版本数/最后更新/代码量） */
    public Map<String, Object> progress(Long teacherId, Long projectId) {
        CodingProject p = requireOwnProject(teacherId, projectId);
        List<StudentProject> sps = studentProjectMapper.selectList(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, p.getId())
                .orderByDesc(StudentProject::getUpdatedAt));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (StudentProject sp : sps) {
            User u = userMapper.selectById(sp.getStudentId());
            if (u == null) {
                continue;
            }
            List<ProjectVersion> vs = projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                    .eq(ProjectVersion::getStudentProjectId, sp.getId())
                    .orderByDesc(ProjectVersion::getVersionNo));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("studentProjectId", sp.getId());
            row.put("studentId", u.getId());
            row.put("name", u.getRealName());
            row.put("studentNo", u.getStudentNo());
            row.put("status", sp.getStatus());
            row.put("versionCount", vs.size());
            ProjectVersion last = vs.isEmpty() ? null : vs.get(0);
            row.put("lastVersionNo", last == null ? null : last.getVersionNo());
            row.put("lastVersionAt", last == null ? null : last.getCreatedAt().format(DT));
            row.put("lastSummary", last == null ? null : last.getSummary());
            row.put("codeSize", last == null ? 0 : last.getCodeSize());
            row.put("updatedAt", sp.getUpdatedAt().format(DT));
            rows.add(row);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("project", toProjectDto(p));
        result.put("students", rows);
        return result;
    }

    /** 教师在线查看：某学生项目的版本列表（迭代记录，不含代码正文，轻量） */
    public List<Map<String, Object>> studentVersions(Long teacherId, Long studentProjectId) {
        StudentProject sp = requireViewableStudentProject(teacherId, studentProjectId);
        List<ProjectVersion> vs = projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo));
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProjectVersion v : vs) {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", v.getId());
            dto.put("versionNo", v.getVersionNo());
            dto.put("summary", v.getSummary());
            dto.put("codeSize", v.getCodeSize());
            dto.put("fileCount", parseFiles(v.getFiles()).size());
            dto.put("createdAt", v.getCreatedAt().format(DT));
            result.add(dto);
        }
        return result;
    }

    /** 教师在线查看：某版本完整代码文件 */
    public Map<String, Object> versionDetail(Long teacherId, Long versionId) {
        ProjectVersion v = projectVersionMapper.selectById(versionId);
        if (v == null) {
            throw new BizException("代码版本不存在");
        }
        requireViewableStudentProject(teacherId, v.getStudentProjectId());
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", v.getId());
        dto.put("studentProjectId", v.getStudentProjectId());
        dto.put("versionNo", v.getVersionNo());
        dto.put("summary", v.getSummary());
        dto.put("codeSize", v.getCodeSize());
        dto.put("createdAt", v.getCreatedAt().format(DT));
        dto.put("files", parseFiles(v.getFiles()));
        return dto;
    }

    /* ==================== 学生端 ==================== */

    /** 学生视角项目列表：本班全部上架项目 + 我的项目状态（实时接收教师发布） */
    public List<Map<String, Object>> myProjects(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null || user.getClassId() == null) {
            return List.of();
        }
        List<CodingProject> projects = codingProjectMapper.selectList(new LambdaQueryWrapper<CodingProject>()
                .eq(CodingProject::getClassId, user.getClassId())
                .eq(CodingProject::getStatus, "PUBLISHED")
                .orderByDesc(CodingProject::getUpdatedAt));
        List<Map<String, Object>> result = new ArrayList<>();
        for (CodingProject p : projects) {
            Map<String, Object> dto = toProjectDto(p);
            StudentProject sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                    .eq(StudentProject::getProjectId, p.getId())
                    .eq(StudentProject::getStudentId, userId));
            if (sp != null) {
                ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                        .eq(ProjectVersion::getStudentProjectId, sp.getId())
                        .orderByDesc(ProjectVersion::getVersionNo)
                        .last("LIMIT 1"));
                dto.put("mine", studentProjectDto(sp, last));
            }
            result.add(dto);
        }
        return result;
    }

    /** 学生创建项目（每项目一份，重复创建幂等返回已有） */
    @Transactional
    public Map<String, Object> start(Long userId, Long projectId) {
        User user = userMapper.selectById(userId);
        if (user == null || user.getClassId() == null) {
            throw new BizException("学生未加入班级");
        }
        CodingProject p = codingProjectMapper.selectById(projectId);
        if (p == null || !Objects.equals(p.getClassId(), user.getClassId()) || !"PUBLISHED".equals(p.getStatus())) {
            throw new BizException("项目不存在或未开放");
        }
        StudentProject sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                .eq(StudentProject::getProjectId, projectId)
                .eq(StudentProject::getStudentId, userId));
        if (sp == null) {
            // 并发下唯一键兜底：第二个插入报 DuplicateKey 由全局异常处理器转 400，事务内幂等
            try {
                sp = new StudentProject();
                sp.setProjectId(projectId);
                sp.setStudentId(userId);
                sp.setStatus("IN_PROGRESS");
                sp.setCreatedAt(LocalDateTime.now());
                sp.setUpdatedAt(LocalDateTime.now());
                studentProjectMapper.insert(sp);
            } catch (org.springframework.dao.DuplicateKeyException e) {
                sp = studentProjectMapper.selectOne(new LambdaQueryWrapper<StudentProject>()
                        .eq(StudentProject::getProjectId, projectId)
                        .eq(StudentProject::getStudentId, userId));
            }
        }
        ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo)
                .last("LIMIT 1"));
        return studentProjectDto(sp, last);
    }

    /** 学生保存代码：自动生成新版本（多版本留存），可同时标记提交 */
    @Transactional
    public Map<String, Object> save(Long userId, Long studentProjectId, String filesJson, String summary, Boolean submit) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权操作");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null || !"PUBLISHED".equals(p.getStatus())) {
            throw new BizException("项目已下架，无法继续开发");
        }
        List<Map<String, String>> files = parseFiles(filesJson);
        if (files.isEmpty()) {
            throw new BizException("至少保存一个代码文件");
        }
        for (Map<String, String> f : files) {
            if (f.get("path") == null || f.get("path").isBlank()) {
                throw new BizException("文件名不能为空");
            }
        }
        // 序号行锁防并发保存撞号（配合唯一键）；同一学生连续保存版本号严格递增
        ProjectVersion last = projectVersionMapper.selectOne(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo)
                .last("LIMIT 1 FOR UPDATE"));
        int nextNo = last == null ? 1 : last.getVersionNo() + 1;
        int size = files.stream().mapToInt(f -> (f.get("content") == null ? "" : f.get("content"))
                .getBytes(java.nio.charset.StandardCharsets.UTF_8).length + f.get("path").getBytes().length).sum();
        ProjectVersion v = new ProjectVersion();
        v.setStudentProjectId(sp.getId());
        v.setVersionNo(nextNo);
        try {
            v.setFiles(objectMapper.writeValueAsString(files));
        } catch (Exception e) {
            throw new BizException("代码文件格式不正确");
        }
        v.setSummary(summary == null ? null : summary.trim());
        v.setCodeSize(size);
        v.setCreatedAt(LocalDateTime.now());
        projectVersionMapper.insert(v);
        if (Boolean.TRUE.equals(submit) && !"SUBMITTED".equals(sp.getStatus())) {
            sp.setStatus("SUBMITTED");
        }
        sp.setUpdatedAt(LocalDateTime.now());
        studentProjectMapper.updateById(sp);
        return studentProjectDto(sp, v);
    }

    /** 学生打开我的项目：最新代码 + 版本列表 */
    public Map<String, Object> mine(Long userId, Long studentProjectId) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权查看");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        List<ProjectVersion> vs = projectVersionMapper.selectList(new LambdaQueryWrapper<ProjectVersion>()
                .eq(ProjectVersion::getStudentProjectId, sp.getId())
                .orderByDesc(ProjectVersion::getVersionNo));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("project", toProjectDto(p));
        ProjectVersion last = vs.isEmpty() ? null : vs.get(0);
        result.put("mine", studentProjectDto(sp, last));
        result.put("versions", vs.stream().map(v -> {
            Map<String, Object> dto = new LinkedHashMap<>();
            dto.put("id", v.getId());
            dto.put("versionNo", v.getVersionNo());
            dto.put("summary", v.getSummary());
            dto.put("codeSize", v.getCodeSize());
            dto.put("createdAt", v.getCreatedAt().format(DT));
            return dto;
        }).collect(Collectors.toList()));
        return result;
    }

    /** 单次运行输出上限（字节），防止死循环刷屏打爆响应 */
    private static final int RUN_OUTPUT_LIMIT = 32 * 1024;
    private static final Pattern MAIN_PATTERN = Pattern.compile("static\\s+void\\s+main\\s*\\(");
    private static final Pattern PUBLIC_CLASS_PATTERN = Pattern.compile("public\\s+class\\s+([A-Za-z_$][\\w$]*)");
    private static final Pattern SAFE_JAVA_NAME = Pattern.compile("[\\w$.-]+\\.java");

    /**
     * 学生运行代码（IDE 风格运行能力）：临时目录写盘 → javac 编译（语法校验）→ java 执行入口类。
     * 编译失败返回 javac 诊断；运行捕获 stdout+stderr 合并输出，超时强制终止；
     * stdin：预置标准输入（≤4KB）写入进程后立即关闭，支持 Scanner 等输入型程序；
     * 运行不留存任何数据，代码版本仍以「保存」为准，结束即清理临时目录。
     */
    public Map<String, Object> run(Long userId, Long studentProjectId, String filesJson, String stdin) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null || !Objects.equals(sp.getStudentId(), userId)) {
            throw new BizException("项目不存在或无权操作");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        List<Map<String, String>> files = parseFiles(filesJson);
        if (files.isEmpty()) {
            throw new BizException("至少需要一个代码文件");
        }
        List<Map<String, String>> javaFiles = new ArrayList<>();
        for (Map<String, String> f : files) {
            String path = f.get("path");
            // 文件名校验：仅允许本目录内的 .java 平面文件名（防路径穿越与非法资源写入）
            if (path == null || !SAFE_JAVA_NAME.matcher(path).matches()) {
                throw new BizException("文件名不合法（仅支持 .java 文件，不允许路径分隔符）");
            }
            javaFiles.add(f);
        }
        // 入口类解析：优先取含 main 方法的 public 类（与声明文件名一致由 javac 校验）
        String mainClass = null;
        for (Map<String, String> f : javaFiles) {
            String content = f.get("content") == null ? "" : f.get("content");
            if (MAIN_PATTERN.matcher(content).find()) {
                Matcher cm = PUBLIC_CLASS_PATTERN.matcher(content);
                if (cm.find()) {
                    mainClass = cm.group(1);
                    break;
                }
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mainClass", mainClass);
        if (mainClass == null) {
            result.put("ok", false);
            result.put("stage", "ENTRY");
            result.put("output", "未找到可运行入口：需要一个包含 public static void main(String[] args) 的 public 类。");
            return result;
        }
        boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
        Path dir = null;
        try {
            dir = Files.createTempDirectory("la-run-");
            for (Map<String, String> f : javaFiles) {
                Files.writeString(dir.resolve(f.get("path")),
                        f.get("content") == null ? "" : f.get("content"), StandardCharsets.UTF_8);
            }
            String javac = Paths.get(System.getProperty("java.home"), "bin", win ? "javac.exe" : "javac").toString();
            // 诊断固定英文（避免中文 Windows 上 javac 输出 GBK 与 UTF-8 读取产生乱码）；
            // 工作目录=临时目录 + 相对路径执行，诊断信息不带系统临时路径前缀，更贴近 IDE 展示
            List<String> compileCmd = new ArrayList<>();
            compileCmd.add(javac);
            compileCmd.add("-J-Duser.language=en");
            compileCmd.add("-encoding");
            compileCmd.add("UTF-8");
            compileCmd.add("-d");
            compileCmd.add(".");
            for (Map<String, String> f : javaFiles) {
                compileCmd.add(f.get("path"));
            }
            ProcOut co = exec(compileCmd, 15, dir, null);
            if (co.exit() != 0) {
                result.put("ok", false);
                result.put("stage", "COMPILE");
                result.put("output", co.output().isBlank()
                        ? "编译未通过（语法校验失败），退出代码 " + co.exit()
                        : "编译未通过（语法校验失败）：\n" + co.output());
                return result;
            }
            String javaBin = Paths.get(System.getProperty("java.home"), "bin", win ? "java.exe" : "java").toString();
            // -Dstdout/-Dstderr.encoding=UTF-8：JDK 19+ 管道场景 System.out 默认取 native 编码
            //（中文 Windows = GBK），导致中文输出乱码；显式固定 UTF-8 与读取端一致
            ProcOut ro = exec(List.of(javaBin, "-Dfile.encoding=UTF-8",
                            "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-cp", ".", mainClass),
                    10, dir, stdin);
            result.put("ok", ro.exit() == 0);
            result.put("stage", "RUN");
            result.put("exitCode", ro.exit());
            result.put("timeout", ro.timeout());
            result.put("output", ro.output());
            return result;
        } catch (IOException e) {
            throw new BizException("运行环境异常，请稍后再试");
        } finally {
            if (dir != null) {
                deleteRecursively(dir);
            }
        }
    }

    /** 进程执行：合并输出流、限时等待、超时连后代一起强杀；stdin 预置标准输入（≤4KB，写完即关闭） */
    private record ProcOut(int exit, String output, boolean timeout) { }

    private static final int STDIN_LIMIT = 4 * 1024;

    private ProcOut exec(List<String> cmd, int timeoutSec, Path workDir, String stdin) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        // 预置标准输入：守护线程写入后立即关闭——Scanner 等输入型程序读到 EOF 正常结束。
        // 线程化写入避免极端情况下（Windows 管道缓冲小于输入量且程序未及时消费）主线程阻塞；
        // 未提供 stdin 时同样关闭写入端，程序读 System.in 直接得到 EOF
        Thread stdinWriter = new Thread(() -> {
            try (var os = proc.getOutputStream()) {
                if (stdin != null && !stdin.isBlank()) {
                    String safe = stdin.length() > STDIN_LIMIT ? stdin.substring(0, STDIN_LIMIT) : stdin;
                    os.write(safe.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            } catch (IOException e) {
                // 程序提前退出导致管道关闭，属正常现象，不影响输出捕获
            }
        });
        stdinWriter.setDaemon(true);
        stdinWriter.start();
        StringBuilder buf = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                char[] chunk = new char[2048];
                int c;
                while ((c = r.read(chunk)) >= 0) {
                    if (buf.length() < RUN_OUTPUT_LIMIT) {
                        buf.append(chunk, 0, Math.min(c, RUN_OUTPUT_LIMIT - buf.length()));
                    }
                }
            } catch (Exception e) {
                // 进程被终止时输入流关闭，属正常现象
            }
        });
        reader.setDaemon(true);
        reader.start();
        boolean finished = false;
        try {
            finished = proc.waitFor(timeoutSec, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (!finished) {
            proc.descendants().forEach(ProcessHandle::destroyForcibly);
            proc.destroyForcibly();
            try { reader.join(1000); } catch (InterruptedException e) { /* 忽略 */ }
            String out = buf.length() > RUN_OUTPUT_LIMIT ? buf.substring(0, RUN_OUTPUT_LIMIT) : buf.toString();
            return new ProcOut(-1, out + "\n运行超时（" + timeoutSec + " 秒），进程已被强制终止。", true);
        }
        try { reader.join(1500); } catch (InterruptedException e) { /* 忽略 */ }
        String out = buf.length() > RUN_OUTPUT_LIMIT
                ? buf.substring(0, RUN_OUTPUT_LIMIT) + "\n…（输出过长已截断）"
                : buf.toString();
        return new ProcOut(proc.exitValue(), out, false);
    }

    private void deleteRecursively(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(f -> {
                try { Files.deleteIfExists(f); } catch (Exception e) { // 清理尽力而为
                }
            });
        } catch (Exception e) { // 清理尽力而为
        }
    }

    /* ==================== 私有 ==================== */

    /**
     * 教师可管理班级口径：授课班级（class.teacher_id）∪ 共同管理班级；
     * 教师无任何可管理班级时回退兼容演示账号（与作业管理 deleteAssignment 同口径）
     */
    private List<Long> manageableClassIds(Long teacherId) {
        List<Long> ids = new ArrayList<>(classMapper.selectList(new LambdaQueryWrapper<ClassEntity>()
                        .eq(ClassEntity::getTeacherId, teacherId))
                .stream().map(ClassEntity::getId).toList());
        classCoTeacherMapper.selectList(new LambdaQueryWrapper<ClassCoTeacher>()
                        .eq(ClassCoTeacher::getTeacherId, teacherId))
                .forEach(ct -> {
                    if (!ids.contains(ct.getClassId())) {
                        ids.add(ct.getClassId());
                    }
                });
        return ids;
    }

    private void requireManageable(Long teacherId, Long classId) {
        List<Long> own = manageableClassIds(teacherId);
        if (!own.isEmpty() && !own.contains(classId)) {
            throw new BizException("无权管理该班级");
        }
    }

    private CodingProject requireOwnProject(Long teacherId, Long projectId) {
        CodingProject p = codingProjectMapper.selectById(projectId);
        if (p == null) {
            throw new BizException("项目不存在");
        }
        try {
            requireManageable(teacherId, p.getClassId());
        } catch (BizException e) {
            throw new BizException("无权操作该项目");
        }
        return p;
    }

    private StudentProject requireViewableStudentProject(Long teacherId, Long studentProjectId) {
        StudentProject sp = studentProjectMapper.selectById(studentProjectId);
        if (sp == null) {
            throw new BizException("学生项目不存在");
        }
        CodingProject p = codingProjectMapper.selectById(sp.getProjectId());
        if (p == null) {
            throw new BizException("项目不存在");
        }
        try {
            requireManageable(teacherId, p.getClassId());
        } catch (BizException e) {
            throw new BizException("无权查看该项目");
        }
        return sp;
    }

    private Map<String, Object> toProjectDto(CodingProject p) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", p.getId());
        dto.put("classId", p.getClassId());
        dto.put("title", p.getTitle());
        dto.put("description", p.getDescription());
        dto.put("status", p.getStatus());
        dto.put("createdAt", p.getCreatedAt() == null ? null : p.getCreatedAt().format(DT));
        dto.put("updatedAt", p.getUpdatedAt() == null ? null : p.getUpdatedAt().format(DT));
        return dto;
    }

    private Map<String, Object> studentProjectDto(StudentProject sp, ProjectVersion last) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", sp.getId());
        dto.put("projectId", sp.getProjectId());
        dto.put("status", sp.getStatus());
        dto.put("versionCount", last == null ? 0 : last.getVersionNo());
        dto.put("lastFiles", last == null ? List.of() : parseFiles(last.getFiles()));
        dto.put("lastSummary", last == null ? null : last.getSummary());
        dto.put("lastVersionAt", last == null ? null : last.getCreatedAt().format(DT));
        dto.put("updatedAt", sp.getUpdatedAt() == null ? null : sp.getUpdatedAt().format(DT));
        return dto;
    }

    private List<Map<String, String>> parseFiles(String filesJson) {
        if (filesJson == null || filesJson.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(filesJson, new TypeReference<List<Map<String, String>>>() {
            });
        } catch (Exception e) {
            return List.of();
        }
    }
}
