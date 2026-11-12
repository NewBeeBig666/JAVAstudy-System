package com.la.service;

import org.apache.poi.xwpf.usermodel.IBodyElement;
import org.apache.poi.xwpf.usermodel.ParagraphAlignment;
import org.apache.poi.xwpf.usermodel.UnderlinePatterns;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFPicture;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 「Word 版面还原预览」解析器：docx → 前端可渲染的文档版面模型 JSON。
 * 与 PPT 幻灯片还原同一思路：解析真实版式属性（页面尺寸/页边距/字号/加粗/颜色/字体/
 * 对齐/缩进/段距/行距/项目符号层级/表格填充与宽度/内嵌图片），前端按 1pt=1px 页面化渲染。
 *
 * 模型结构（坐标/尺寸均 pt）：
 * { w, h, marginL/R/T/B, blocks: [
 *     { t:"p", align, bullet, level, heading, firstLine, indentL, before, after, line, lineExact,
 *       runs:[{ k:"txt", x, size, bold, italic, underline, color, font } | { k:"img", src, w, h }] },
 *     { t:"tbl", width, rows:[{ h, cells:[{ fill, w, paras:[...] }] }] }
 * ] }
 *
 * Word 为流式文档：段落按文档顺序输出，字号未显式设置时由前端按样式兜底；
 * .doc（HWPF 老格式）不走此解析，保留既有结构化文本视图。
 */
public final class DocPageParser {

    private DocPageParser() {
    }

    private static final int MAX_PARAS = 800;
    private static final int MAX_RUNS_PER_PARA = 120;

    public static Map<String, Object> parse(Path file) throws Exception {
        try (XWPFDocument doc = new XWPFDocument(Files.newInputStream(file))) {
            Map<String, Object> model = new LinkedHashMap<>();
            // 页面几何：宽/高/页边距（twips → pt = /20），缺省 A4 + Word 默认边距
            double w = 595.3, h = 841.9, mTop = 72, mRight = 90, mBottom = 72, mLeft = 90;
            try {
                var sectPr = doc.getDocument().getBody().getSectPr();
                if (sectPr != null) {
                    if (sectPr.isSetPgSz() && sectPr.getPgSz() != null) {
                        w = twips(sectPr.getPgSz().getW(), w);
                        h = twips(sectPr.getPgSz().getH(), h);
                    }
                    if (sectPr.isSetPgMar() && sectPr.getPgMar() != null) {
                        mTop = twips(sectPr.getPgMar().getTop(), mTop);
                        mRight = twips(sectPr.getPgMar().getRight(), mRight);
                        mBottom = twips(sectPr.getPgMar().getBottom(), mBottom);
                        mLeft = twips(sectPr.getPgMar().getLeft(), mLeft);
                    }
                }
            } catch (Exception e) { // 未设置节属性 → 使用缺省页面几何
            }
            model.put("w", Math.round(w * 10) / 10.0);
            model.put("h", Math.round(h * 10) / 10.0);
            model.put("marginT", Math.round(mTop * 10) / 10.0);
            model.put("marginR", Math.round(mRight * 10) / 10.0);
            model.put("marginB", Math.round(mBottom * 10) / 10.0);
            model.put("marginL", Math.round(mLeft * 10) / 10.0);

            List<Map<String, Object>> blocks = new ArrayList<>();
            int paras = 0;
            for (IBodyElement el : doc.getBodyElements()) {
                if (paras >= MAX_PARAS) {
                    break;
                }
                try {
                    if (el instanceof XWPFParagraph p) {
                        paras++;
                        Map<String, Object> b = paragraph(p);
                        if (b != null) {
                            blocks.add(b);
                        }
                    } else if (el instanceof XWPFTable t) {
                        Map<String, Object> b = table(t);
                        if (b != null) {
                            blocks.add(b);
                        }
                    }
                } catch (Exception e) {
                    // 单块解析失败跳过，不影响整篇其余内容
                }
            }
            model.put("blocks", blocks);
            return model;
        }
    }

    /** OOXML union 度量值（STSignedTwipsMeasure 等，getter 返回 Object）→ long；无效回退默认 */
    private static long toLong(Object v, long dft) {
        if (v == null) {
            return dft;
        }
        if (v instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(v.toString().trim());
        } catch (Exception e) {
            return dft;
        }
    }

    private static double twips(Object v, double dft) {
        long x = toLong(v, Long.MIN_VALUE);
        return x == Long.MIN_VALUE ? dft : x / 20.0;
    }

    /* ---------------- 段落 → 模型 ---------------- */

    private static Map<String, Object> paragraph(XWPFParagraph p) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("t", "p");
        try {
            ParagraphAlignment a = p.getAlignment();
            b.put("align", a == null ? null : a.name());
        } catch (Exception e) {
            b.put("align", null);
        }
        try {
            b.put("bullet", p.getNumID() != null);
            b.put("level", p.getNumIlvl() == null ? 0 : p.getNumIlvl().intValue());
        } catch (Exception e) {
            b.put("bullet", false);
            b.put("level", 0);
        }
        // 标题样式（heading N → 前端字号兜底）
        String heading = null;
        try {
            String styleId = p.getStyleID();
            if (styleId != null) {
                java.util.regex.Matcher mh = java.util.regex.Pattern
                        .compile("(?i)heading\\s*([1-9])").matcher(styleId);
                if (mh.find()) {
                    heading = String.valueOf(Math.min(3, Integer.parseInt(mh.group(1))));
                }
            }
        } catch (Exception e) { // 样式取不到按正文处理
        }
        b.put("heading", heading);
        try {
            // POI 未设置时返回 -1（twips）→ 按 0 处理
            b.put("firstLine", Math.max(0, p.getIndentationFirstLine()) / 20.0);
        } catch (Exception e) {
            b.put("firstLine", 0);
        }
        try {
            b.put("indentL", Math.max(0, p.getIndentationLeft()) / 20.0);
        } catch (Exception e) {
            b.put("indentL", 0);
        }
        try {
            b.put("before", Math.max(0, p.getSpacingBefore()) / 20.0);
            b.put("after", Math.max(0, p.getSpacingAfter()) / 20.0);
        } catch (Exception e) {
            b.put("before", 0);
            b.put("after", 0);
        }
        // 行距：AUTO 时 line/240 为倍数；EXACT/AT_LEAST 时 line/20 为磅
        Double line = null;
        Double lineExact = null;
        try {
            var spacing = p.getCTP().getPPr() == null ? null : p.getCTP().getPPr().getSpacing();
            if (spacing != null && spacing.isSetLine()) {
                long lv = toLong(spacing.getLine(), -1);
                if (lv >= 0) {
                    if ("auto".equalsIgnoreCase(String.valueOf(spacing.getLineRule()))) {
                        line = Math.round(lv / 240.0 * 100) / 100.0;
                    } else {
                        lineExact = Math.round(lv / 20.0 * 10) / 10.0;
                    }
                }
            }
        } catch (Exception e) { // 未设行距 → 前端默认
        }
        b.put("line", line);
        b.put("lineExact", lineExact);
        // 文本运行与内嵌图片（按文档顺序交错输出）
        List<Map<String, Object>> runs = new ArrayList<>();
        for (XWPFRun r : p.getRuns()) {
            if (runs.size() >= MAX_RUNS_PER_PARA) {
                break;
            }
            try {
                // 内嵌图片先于/伴随文本输出（Word 中图片通常独占 run）
                for (XWPFPicture pic : r.getEmbeddedPictures()) {
                    String src = PptSlideParser.imageData(pic.getPictureData().getData(),
                            pic.getPictureData().getPackagePart().getContentType());
                    if (src == null) {
                        continue;
                    }
                    double[] dims = imageDims(pic.getPictureData().getData());
                    runs.add(Map.of("k", "img", "src", src, "w", dims[0], "h", dims[1]));
                }
                String txt = r.getText(0);
                if (txt == null || txt.isEmpty()) {
                    continue;
                }
                Map<String, Object> rm = new LinkedHashMap<>();
                rm.put("k", "txt");
                rm.put("x", txt.length() > 4000 ? txt.substring(0, 4000) : txt);
                int fs = r.getFontSize();
                rm.put("size", fs > 0 ? fs : null);
                rm.put("bold", r.isBold());
                rm.put("italic", r.isItalic());
                try {
                    rm.put("underline", r.getUnderline() != UnderlinePatterns.NONE);
                } catch (Exception e) {
                    rm.put("underline", false);
                }
                String color = r.getColor();
                rm.put("color", color == null || "auto".equalsIgnoreCase(color) ? null : "#" + color.toLowerCase());
                rm.put("font", r.getFontFamily());
                runs.add(rm);
            } catch (Exception e) {
                // 单 run 失败跳过
            }
        }
        b.put("runs", runs);
        // 空段落保留占位（原文中的空行是版式的一部分）
        return b;
    }

    /* ---------------- 表格 → 模型 ---------------- */

    private static Map<String, Object> table(XWPFTable t) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("t", "tbl");
        // 表宽：pct 类型 → 百分比小数；dxa → pt；缺省 100%
        double width = 100;
        try {
            var tblPr = t.getCTTbl().getTblPr();
            if (tblPr != null && tblPr.isSetTblW() && tblPr.getTblW() != null) {
                long v = toLong(tblPr.getTblW().getW(), -1);
                String type = tblPr.getTblW().getType() == null ? "auto" : tblPr.getTblW().getType().toString();
                if ("pct".equalsIgnoreCase(type)) {
                    width = Math.round(v / 50.0) / 100.0; // fiftieths of a percent → 比例
                } else if ("dxa".equalsIgnoreCase(type)) {
                    width = v / 20.0;
                    b.put("widthPt", true);
                }
            }
        } catch (Exception e) { // 缺省 100% 宽
        }
        b.put("width", Math.round(width * 1000) / 1000.0);
        List<Map<String, Object>> rows = new ArrayList<>();
        int rn = 0;
        for (XWPFTableRow row : t.getRows()) {
            if (rn++ > 120) {
                break;
            }
            Map<String, Object> rm = new LinkedHashMap<>();
            try {
                rm.put("h", row.getHeight() > 0 ? row.getHeight() / 20.0 : null);
            } catch (Exception e) {
                rm.put("h", null);
            }
            List<Map<String, Object>> cells = new ArrayList<>();
            for (XWPFTableCell cell : row.getTableCells()) {
                Map<String, Object> cm = new LinkedHashMap<>();
                try {
                    String fill = cell.getColor();
                    cm.put("fill", fill == null || "auto".equalsIgnoreCase(fill) ? null : "#" + fill.toLowerCase());
                } catch (Exception e) {
                    cm.put("fill", null);
                }
                try {
                    var tcW = cell.getCTTc().getTcPr() == null ? null : cell.getCTTc().getTcPr().getTcW();
                    if (tcW != null && "dxa".equalsIgnoreCase(String.valueOf(tcW.getType()))
                            && toLong(tcW.getW(), -1) > 0) {
                        cm.put("w", toLong(tcW.getW(), -1) / 20.0);
                    } else {
                        cm.put("w", null);
                    }
                } catch (Exception e) {
                    cm.put("w", null);
                }
                List<Map<String, Object>> paras = new ArrayList<>();
                for (XWPFParagraph p : cell.getParagraphs()) {
                    Map<String, Object> pm = paragraph(p);
                    if (pm != null) {
                        paras.add(pm);
                    }
                }
                cm.put("paras", paras);
                cells.add(cm);
            }
            rm.put("cells", cells);
            rows.add(rm);
        }
        b.put("rows", rows);
        return b;
    }

    /** 图片显示尺寸：优先 EMU 尺寸（绘图锚点），否则按像素 96dpi 换算 pt */
    private static double[] imageDims(byte[] bytes) {
        try {
            BufferedImage img = ImageIO.read(new ByteArrayInputStream(bytes));
            if (img != null) {
                // Word 内嵌图通常按 96dpi 存储展示像素 → pt = px * 72/96
                return new double[]{ Math.round(img.getWidth() * 0.75 * 10) / 10.0,
                        Math.round(img.getHeight() * 0.75 * 10) / 10.0 };
            }
        } catch (Exception e) { // 读取失败 → 前端按自然尺寸渲染
        }
        return new double[]{ 0, 0 };
    }
}
