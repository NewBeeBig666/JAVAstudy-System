package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.ClassEntity;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.ClassMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.hwpf.HWPFDocument;
import org.apache.poi.hwpf.extractor.WordExtractor;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 班级名单导入：解析 Excel(.xlsx/.xls) / Word(.docx/.doc)，
 * 识别学生名单并创建班级 + 批量注册学生账号。
 *
 * 解析规则：
 * 1) 表格类（Excel 工作表 / docx 表格）：首行表头中定位「学号|工号」与「姓名」列，
 *    存在「班级」列时取首个非空值作为班级名；
 * 2) 文本类（docx 段落 / doc 全文）：按行正则匹配「学号 姓名」对；
 * 3) 班级名优先级：班级列值 > 文件名（去扩展名）> 「新班级-yyyyMMddHHmm」；
 * 4) 学生账号 = 学号，初始密码统一 GZgs@2026（BCrypt 存储），已存在的学号自动跳过。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ClassImportService {

    private final ClassMapper classMapper;
    private final UserMapper userMapper;
    private final PasswordEncoder passwordEncoder;

    /** 兜底文本行匹配：学号(7-12位数字，2开头) + 中文姓名 */
    private static final Pattern ROW_PATTERN =
            Pattern.compile("(2\\d{7,12})[\\s,，、\\t]+([\\u4e00-\\u9fa5·]{2,5})");

    @Transactional
    public Map<String, Object> importClass(Long teacherId, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BizException("请选择要上传的文件");
        }
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        String lower = name.toLowerCase();
        Parsed parsed;
        try (InputStream in = file.getInputStream()) {
            if (lower.endsWith(".xlsx")) {
                // Workbook 自身也需关闭（POI 包内资源），与流一并 try-with-resources
                try (XSSFWorkbook wb = new XSSFWorkbook(in)) {
                    parsed = parseExcel(wb);
                }
            } else if (lower.endsWith(".xls")) {
                try (org.apache.poi.hssf.usermodel.HSSFWorkbook wb = new org.apache.poi.hssf.usermodel.HSSFWorkbook(in)) {
                    parsed = parseExcel(wb);
                }
            } else if (lower.endsWith(".docx")) {
                parsed = parseDocx(in);
            } else if (lower.endsWith(".doc")) {
                parsed = parseDoc(in);
            } else {
                throw new BizException("不支持的文件格式，仅支持 .xlsx / .xls / .docx / .doc");
            }
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            log.error("班级名单解析失败: {}", e.getMessage());
            throw new BizException("文件解析失败，请确认文档为标准 Excel/Word 格式");
        }
        if (parsed.students.isEmpty()) {
            throw new BizException("未在文档中识别到学生名单（需包含学号与姓名）");
        }

        // 班级名：班级列 > 文件名 > 默认
        String className = parsed.className;
        if (className == null || className.isBlank()) {
            int dot = name.lastIndexOf('.');
            className = dot > 0 ? name.substring(0, dot) : "新班级";
        }
        className = className.trim();
        if (className.length() > 100) {
            className = className.substring(0, 100);
        }

        // 创建班级（绑定当前教师）
        ClassEntity cls = new ClassEntity();
        cls.setName(className);
        cls.setGrade(String.valueOf(java.time.Year.now().getValue()));
        cls.setTeacherId(teacherId);
        classMapper.insert(cls);

        // 批量注册学生（学号已存在则跳过）
        String hash = passwordEncoder.encode("GZgs@2026");
        int inserted = 0;
        int skipped = 0;
        for (StudentRow r : parsed.students) {
            Long exists = userMapper.selectCount(new LambdaQueryWrapper<User>()
                    .eq(User::getUsername, r.studentNo));
            if (exists > 0) {
                skipped++;
                continue;
            }
            User u = new User();
            u.setUsername(r.studentNo);
            u.setPasswordHash(hash);
            u.setRealName(r.name);
            u.setRole("STUDENT");
            u.setStudentNo(r.studentNo);
            u.setClassId(cls.getId());
            u.setCreatedAt(java.time.LocalDateTime.now());
            userMapper.insert(u);
            inserted++;
        }
        log.info("[班级导入] teacher={}, class={}, 学生={} 新增 / {} 跳过",
                teacherId, className, inserted, skipped);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("classId", cls.getId());
        result.put("className", className);
        result.put("studentCount", inserted);
        result.put("skipped", skipped);
        return result;
    }

    private static class StudentRow {
        final String studentNo;
        final String name;

        StudentRow(String studentNo, String name) {
            this.studentNo = studentNo;
            this.name = name;
        }
    }

    private static class Parsed {
        String className;
        final List<StudentRow> students = new ArrayList<>();
    }

    /* ---------------- Excel（.xlsx / .xls） ---------------- */
    private Parsed parseExcel(Workbook wb) {
        Parsed parsed = new Parsed();
        Sheet sheet = wb.getSheetAt(0);
        int noIdx = -1, nameIdx = -1, classIdx = -1;
        // 在前 5 行内定位表头
        for (int r = 0; r < Math.min(5, sheet.getLastRowNum() + 1) && noIdx < 0; r++) {
            Row row = sheet.getRow(r);
            if (row == null) continue;
            for (int c = 0; c < row.getLastCellNum(); c++) {
                String v = cellText(row.getCell(c));
                if (v.contains("学号") || v.contains("工号")) noIdx = c;
                else if (v.contains("姓名")) nameIdx = c;
                else if (v.contains("班级")) classIdx = c;
            }
        }
        if (noIdx >= 0 && nameIdx >= 0) {
            for (int r = 0; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;
                String no = cellText(row.getCell(noIdx)).trim();
                String nm = cellText(row.getCell(nameIdx)).trim();
                if (no.matches("2\\d{7,12}") && !nm.isEmpty()) {
                    parsed.students.add(new StudentRow(no, nm));
                    if (classIdx >= 0 && parsed.className == null) {
                        String cn = cellText(row.getCell(classIdx)).trim();
                        if (!cn.isEmpty() && !cn.contains("班")) {
                            parsed.className = cn;
                        } else if (!cn.isEmpty()) {
                            parsed.className = cn;
                        }
                    }
                }
            }
        } else {
            // 无标准表头：逐行文本匹配
            for (int r = 0; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;
                StringBuilder sb = new StringBuilder();
                for (int c = 0; c < row.getLastCellNum(); c++) {
                    sb.append(cellText(row.getCell(c))).append('\t');
                }
                matchTextRow(parsed, sb.toString());
            }
        }
        return parsed;
    }

    private String cellText(Cell cell) {
        if (cell == null) return "";
        if (cell.getCellType() == CellType.NUMERIC) {
            // 学号列常见为数值型，避免科学计数法
            double d = cell.getNumericCellValue();
            if (d == Math.floor(d)) {
                return String.valueOf((long) d);
            }
            return String.valueOf(d);
        }
        cell.setCellType(CellType.STRING);
        return cell.getStringCellValue() == null ? "" : cell.getStringCellValue().trim();
    }

    /* ---------------- Word docx ---------------- */
    private Parsed parseDocx(InputStream in) throws Exception {
        Parsed parsed = new Parsed();
        try (XWPFDocument doc = new XWPFDocument(in)) {
            // 优先：表格中定位表头
            outer:
            for (XWPFTable table : doc.getTables()) {
                List<XWPFTableRow> rows = table.getRows();
                if (rows.isEmpty()) continue;
                List<String> header = rowTexts(rows.get(0));
                int noIdx = -1, nameIdx = -1, classIdx = -1;
                for (int c = 0; c < header.size(); c++) {
                    String v = header.get(c);
                    if (v.contains("学号") || v.contains("工号")) noIdx = c;
                    else if (v.contains("姓名")) nameIdx = c;
                    else if (v.contains("班级")) classIdx = c;
                }
                if (noIdx >= 0 && nameIdx >= 0) {
                    for (int r = 1; r < rows.size(); r++) {
                        List<String> cells = rowTexts(rows.get(r));
                        String no = get(cells, noIdx);
                        String nm = get(cells, nameIdx);
                        if (no.matches("2\\d{7,12}") && !nm.isEmpty()) {
                            parsed.students.add(new StudentRow(no, nm));
                            if (classIdx >= 0 && parsed.className == null) {
                                String cn = get(cells, classIdx);
                                if (!cn.isEmpty()) parsed.className = cn;
                            }
                        }
                    }
                    break outer;
                }
            }
            // 兜底：段落文本逐行匹配
            if (parsed.students.isEmpty()) {
                doc.getParagraphs().forEach(p -> matchTextRow(parsed, p.getText()));
            }
        }
        return parsed;
    }

    private List<String> rowTexts(XWPFTableRow row) {
        List<String> out = new ArrayList<>();
        row.getTableCells().forEach(c -> out.add(c.getText() == null ? "" : c.getText().trim()));
        return out;
    }

    private String get(List<String> list, int idx) {
        return idx < list.size() ? list.get(idx).trim() : "";
    }

    /* ---------------- Word doc（老格式） ---------------- */
    private Parsed parseDoc(InputStream in) throws Exception {
        Parsed parsed = new Parsed();
        try (HWPFDocument doc = new HWPFDocument(in);
             WordExtractor ex = new WordExtractor(doc)) {
            for (String p : ex.getParagraphText()) {
                matchTextRow(parsed, p);
            }
        }
        return parsed;
    }

    /* ---------------- 文本行兜底匹配 ---------------- */
    private void matchTextRow(Parsed parsed, String text) {
        if (text == null || text.isEmpty()) return;
        Matcher m = ROW_PATTERN.matcher(text);
        while (m.find()) {
            parsed.students.add(new StudentRow(m.group(1), m.group(2)));
        }
    }
}
