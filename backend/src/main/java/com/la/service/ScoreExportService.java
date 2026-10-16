package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.Assignment;
import com.la.entity.ClassEntity;
import com.la.entity.Submission;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.AssignmentMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.SubmissionMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.xssf.streaming.SXSSFSheet;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 教师端成绩导出：生成班级作业成绩 Excel（SXSSF 流式写出，大数据量稳定不占内存）
 *
 * 表结构：一行一个学生，列 = 姓名 | 学号 | 每份作业 3 列（AI初评 / 最终成绩 / 提交时间），
 * 双行表头（作业名跨 3 列合并），支持按作业发布时间段筛选。
 */
@Service
@RequiredArgsConstructor
public class ScoreExportService {

    private final ClassMapper classMapper;
    private final UserMapper userMapper;
    private final AssignmentMapper assignmentMapper;
    private final SubmissionMapper submissionMapper;

    private static final DateTimeFormatter EXPORT_TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter FILE_TS = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    /** 每个学生一行；生成列：学号 | 姓名 | 作业1（AI初评/最终成绩/提交时间） | 作业2 ... */
    public ResponseEntity<byte[]> export(Long classId, String start, String end) {
        ClassEntity cls = classMapper.selectById(classId);
        if (cls == null) {
            throw new BizException("班级不存在");
        }
        LocalDateTime from = parseTime(start, true);
        LocalDateTime to = parseTime(end, false);
        if (from != null && to != null && from.isAfter(to)) {
            throw new BizException("开始时间不能晚于结束时间");
        }

        // 学生：按学号升序
        List<User> students = userMapper.selectList(new LambdaQueryWrapper<User>()
                        .eq(User::getClassId, classId).eq(User::getRole, "STUDENT"))
                .stream()
                .sorted(Comparator.comparing(u -> u.getStudentNo() == null ? "" : u.getStudentNo()))
                .toList();
        if (students.isEmpty()) {
            throw new BizException("该班级暂无学生，没有可导出的成绩");
        }

        // 作业：排除草稿（未发布给学生，无成绩），支持按发布时间（createdAt）时间段筛选
        LambdaQueryWrapper<Assignment> qw = new LambdaQueryWrapper<Assignment>()
                .eq(Assignment::getClassId, classId)
                .ne(Assignment::getStatus, "DRAFT")
                .ge(from != null, Assignment::getCreatedAt, from)
                .le(to != null, Assignment::getCreatedAt, to)
                .orderByAsc(Assignment::getCreatedAt);
        List<Assignment> assignments = assignmentMapper.selectList(qw);
        if (assignments.isEmpty()) {
            throw new BizException(from == null
                    ? "该班级还没有已发布的作业，没有可导出的成绩"
                    : "所选时间段内没有已发布的作业，请调整时间范围");
        }

        // 提交记录：assignmentId + studentId -> submission（重新提交为同一行，attempts 递增）
        Map<Long, Map<Long, Submission>> subIndex = submissionMapper.selectList(
                        new LambdaQueryWrapper<Submission>().in(Submission::getAssignmentId,
                                assignments.stream().map(Assignment::getId).toList()))
                .stream()
                .collect(Collectors.groupingBy(Submission::getAssignmentId,
                        Collectors.toMap(Submission::getStudentId, s -> s, (a, b) -> a)));

        byte[] body;
        try {
            body = buildWorkbook(cls, students, assignments, subIndex, from, to);
        } catch (IOException e) {
            throw new BizException("生成 Excel 失败，请稍后重试");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
        String fileName = cls.getName() + "-作业成绩-" + LocalDateTime.now().format(FILE_TS) + ".xlsx";
        // RFC 5987：中文文件名按 UTF-8 编码放入 filename*，兼容各浏览器
        headers.setContentDisposition(ContentDisposition.attachment()
                .filename(fileName, java.nio.charset.StandardCharsets.UTF_8).build());

        return ResponseEntity.ok().headers(headers).body(body);
    }

    private byte[] buildWorkbook(ClassEntity cls, List<User> students, List<Assignment> assignments,
                                 Map<Long, Map<Long, Submission>> subIndex,
                                 LocalDateTime from, LocalDateTime to) throws IOException {
        // 窗口 100 行流式写：成绩表通常几十~几百行，大数据量也不会 OOM / 长时间卡顿
        try (SXSSFWorkbook wb = new SXSSFWorkbook(100)) {
            SXSSFSheet sheet = wb.createSheet("作业成绩");
            sheet.setRandomAccessWindowSize(100);

            int totalCols = 2 + assignments.size() * 3;

            CellStyle titleStyle = titleStyle(wb);
            CellStyle subTitleStyle = subTitleStyle(wb);
            CellStyle headStyle = headStyle(wb);
            CellStyle textCell = textStyle(wb);
            CellStyle centerCell = centerStyle(wb);
            CellStyle numCell = numStyle(wb);

            // 第 1 行：标题
            Row r0 = sheet.createRow(0);
            r0.setHeightInPoints(28);
            createCell(r0, 0, cls.getName() + " · 作业成绩表", titleStyle);
            sheet.addMergedRegion(new CellRangeAddress(0, 0, 0, Math.max(totalCols - 1, 0)));

            // 第 2 行：导出说明（时间范围 / 作业数 / 学生数）
            Row r1 = sheet.createRow(1);
            String rangeDesc = from != null
                    ? "作业发布时间：" + from.format(EXPORT_TS) + " ~ " + to.format(EXPORT_TS)
                    : "作业发布时间：全部（截止导出时刻，含最新作业）";
            createCell(r1, 0, "导出时间：" + LocalDateTime.now().format(EXPORT_TS)
                    + " · " + rangeDesc + " · 作业 " + assignments.size() + " 份 · 学生 " + students.size() + " 人",
                    subTitleStyle);
            sheet.addMergedRegion(new CellRangeAddress(1, 1, 0, Math.max(totalCols - 1, 0)));

            // 第 3-4 行：双行表头（姓名 / 学号 纵向合并；作业名跨 3 列横向合并）
            Row h1 = sheet.createRow(2);
            h1.setHeightInPoints(30);
            Row h2 = sheet.createRow(3);
            sheet.addMergedRegion(new CellRangeAddress(2, 3, 0, 0));
            sheet.addMergedRegion(new CellRangeAddress(2, 3, 1, 1));
            createCell(h1, 0, "姓名", headStyle);
            createCell(h2, 0, "姓名", headStyle);
            createCell(h1, 1, "学号", headStyle);
            createCell(h2, 1, "学号", headStyle);
            for (int i = 0; i < assignments.size(); i++) {
                int c = 2 + i * 3;
                String t = assignments.get(i).getTitle();
                createCell(h1, c, t, headStyle);
                createCell(h1, c + 1, t, headStyle);
                createCell(h1, c + 2, t, headStyle);
                sheet.addMergedRegion(new CellRangeAddress(2, 2, c, c + 2));
                createCell(h2, c, "AI初评", headStyle);
                createCell(h2, c + 1, "最终成绩", headStyle);
                createCell(h2, c + 2, "提交时间", headStyle);
            }

            // 数据行：一行一个学生；未提交的作业留空，便于后续统计分析
            int rowIdx = 4;
            for (User stu : students) {
                Row row = sheet.createRow(rowIdx++);
                String no = stu.getStudentNo() != null ? stu.getStudentNo() : stu.getUsername();
                createCell(row, 0, stu.getRealName(), textCell);
                createCell(row, 1, no, centerCell);
                for (int i = 0; i < assignments.size(); i++) {
                    Assignment as = assignments.get(i);
                    int c = 2 + i * 3;
                    Submission sub = subIndex.getOrDefault(as.getId(), new HashMap<>()).get(stu.getId());
                    if (sub == null) {
                        createCell(row, c, "", centerCell);
                        createCell(row, c + 1, "", centerCell);
                        createCell(row, c + 2, "", centerCell);
                    } else {
                        createNum(row, c, sub.getAiScore(), numCell);
                        createNum(row, c + 1, sub.getScore(), numCell);
                        createCell(row, c + 2,
                                sub.getSubmittedAt() != null ? sub.getSubmittedAt().format(EXPORT_TS) : "",
                                centerCell);
                    }
                }
            }

            // 冻结前 2 列 + 表头，横向滚动时保持学生信息可见
            sheet.createFreezePane(2, 4, 2, 4);
            // 列宽（1/256 字符单位）
            sheet.setColumnWidth(0, 12 * 256);
            sheet.setColumnWidth(1, 14 * 256);
            for (int i = 0; i < assignments.size(); i++) {
                int c = 2 + i * 3;
                sheet.setColumnWidth(c, 9 * 256);
                sheet.setColumnWidth(c + 1, 9 * 256);
                sheet.setColumnWidth(c + 2, 19 * 256);
            }

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            wb.write(bos);
            return bos.toByteArray();
        }
    }

    private void createCell(Row row, int col, Object value, CellStyle style) {
        Cell cell = row.createCell(col);
        if (value instanceof Integer || value instanceof Long) {
            cell.setCellValue(((Number) value).doubleValue());
        } else {
            cell.setCellValue(value == null ? "" : String.valueOf(value));
        }
        cell.setCellStyle(style);
    }

    private void createNum(Row row, int col, Integer value, CellStyle style) {
        Cell cell = row.createCell(col);
        if (value != null) {
            cell.setCellValue(value);
        }
        cell.setCellStyle(style);
    }

    /** 宽松时间解析：支持 yyyy-MM-dd 与 yyyy-MM-dd HH:mm(:ss)；start 取当天 00:00，end 取当天 23:59:59.999 */
    private LocalDateTime parseTime(String s, boolean startOf) {
        if (s == null || s.isBlank()) {
            return null;
        }
        String t = s.trim();
        if (t.length() == 10) {
            LocalDateTime d = LocalDateTime.parse(t + (startOf ? "T00:00:00" : "T23:59:59"));
            return d;
        }
        try {
            return LocalDateTime.parse(t.replace(' ', 'T'));
        } catch (Exception e) {
            throw new BizException("时间格式不正确：" + s + "（应为 yyyy-MM-dd）");
        }
    }

    private CellStyle titleStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        Font f = wb.createFont();
        f.setBold(true);
        f.setFontHeightInPoints((short) 15);
        st.setFont(f);
        st.setAlignment(HorizontalAlignment.CENTER);
        return st;
    }

    private CellStyle subTitleStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        Font f = wb.createFont();
        f.setFontHeightInPoints((short) 10);
        f.setColor(IndexedColors.GREY_50_PERCENT.getIndex());
        st.setFont(f);
        st.setAlignment(HorizontalAlignment.CENTER);
        return st;
    }

    private CellStyle headStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        Font f = wb.createFont();
        f.setBold(true);
        f.setFontHeightInPoints((short) 11);
        st.setFont(f);
        st.setAlignment(HorizontalAlignment.CENTER);
        st.setWrapText(true);
        st.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
        st.setFillPattern(FillPatternType.SOLID_FOREGROUND);
        setThinBorder(st);
        return st;
    }

    private CellStyle textStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        st.setAlignment(HorizontalAlignment.LEFT);
        setThinBorder(st);
        return st;
    }

    private CellStyle centerStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        st.setAlignment(HorizontalAlignment.CENTER);
        setThinBorder(st);
        return st;
    }

    private CellStyle numStyle(SXSSFWorkbook wb) {
        CellStyle st = wb.createCellStyle();
        st.setAlignment(HorizontalAlignment.CENTER);
        setThinBorder(st);
        return st;
    }

    private void setThinBorder(CellStyle st) {
        st.setBorderTop(BorderStyle.THIN);
        st.setBorderBottom(BorderStyle.THIN);
        st.setBorderLeft(BorderStyle.THIN);
        st.setBorderRight(BorderStyle.THIN);
    }
}
