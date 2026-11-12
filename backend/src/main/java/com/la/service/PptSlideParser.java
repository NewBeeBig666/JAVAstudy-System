package com.la.service;

import org.apache.poi.sl.usermodel.AutoShape;
import org.apache.poi.sl.usermodel.GroupShape;
import org.apache.poi.sl.usermodel.PaintStyle;
import org.apache.poi.sl.usermodel.PictureData;
import org.apache.poi.sl.usermodel.PictureShape;
import org.apache.poi.sl.usermodel.Shape;
import org.apache.poi.sl.usermodel.ShapeType;
import org.apache.poi.sl.usermodel.SimpleShape;
import org.apache.poi.sl.usermodel.Slide;
import org.apache.poi.sl.usermodel.SlideShow;
import org.apache.poi.sl.usermodel.SlideShowFactory;
import org.apache.poi.sl.usermodel.TableCell;
import org.apache.poi.sl.usermodel.TableShape;
import org.apache.poi.sl.usermodel.TextParagraph;
import org.apache.poi.sl.usermodel.TextRun;
import org.apache.poi.sl.usermodel.TextShape;
import org.apache.poi.sl.usermodel.VerticalAlignment;

import javax.imageio.ImageIO;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 「PPT 幻灯片还原预览」解析器：ppt/pptx → 前端可渲染的幻灯片模型 JSON。
 * 统一走 POI 通用 SL 接口（SlideShowFactory 自动嗅探 ppt/pptx，XSLF/HSLF 一套代码通吃）。
 *
 * 模型结构（坐标/尺寸均为磅 pt，前端按 1pt=1px 渲染后整体 transform:scale 适配容器）：
 * { w, h, slides: [ { shapes: [
 *     { t:"text", x,y,w,h, fill, round, insetL/R/T/B, valign,
 *       paras:[{ align, bullet, level, runs:[{ x,size,bold,italic,color,font }] }] },
 *     { t:"table", x,y,w,h, rows:[{ h, cells:[{ x,y,w,h, fill, paras }] }] },
 *     { t:"pic", x,y,w,h, src:"data:image/..;base64,.." }
 * ] } ] }
 *
 * 保真边界：文本框/自动形状（含填充色与圆角）/表格（逐单元格绝对定位）/图片（大图降采样）；
 * 组合形状展平、组合内坐标近似；EMF/WMF 等浏览器不支持的图元跳过；单形状解析失败不中断整页。
 */
public final class PptSlideParser {

    private PptSlideParser() {
    }

    private static final int MAX_SLIDES = 300;
    private static final int MAX_SHAPES_PER_SLIDE = 80;
    private static final int IMG_DOWNSCALE_BYTES = 150_000;
    private static final int IMG_DOWNSCALE_WIDTH = 900;

    public static Map<String, Object> parse(Path file) throws Exception {
        try (SlideShow<?, ?> ppt = SlideShowFactory.create(file.toFile())) {
            Dimension sz = ppt.getPageSize();
            List<Map<String, Object>> slides = new ArrayList<>();
            int n = 0;
            for (Slide<?, ?> slide : ppt.getSlides()) {
                if (++n > MAX_SLIDES) {
                    break;
                }
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("shapes", shapes(slide.getShapes()));
                slides.add(s);
            }
            Map<String, Object> model = new LinkedHashMap<>();
            model.put("w", (double) sz.width);
            model.put("h", (double) sz.height);
            model.put("slides", slides);
            return model;
        }
    }

    /* ---------------- 形状遍历（组合形状展平） ---------------- */

    private static List<Map<String, Object>> shapes(List<? extends Shape<?, ?>> list) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Shape<?, ?> s : list) {
            if (out.size() >= MAX_SHAPES_PER_SLIDE) {
                break;
            }
            try {
                if (s instanceof GroupShape) {
                    GroupShape<?, ?> g = (GroupShape<?, ?>) s;
                    out.addAll(shapes(g.getShapes()));
                } else if (s instanceof TableShape) {
                    out.add(tableShape((TableShape<?, ?>) s));
                } else if (s instanceof PictureShape) {
                    Map<String, Object> m = pictureShape((PictureShape<?, ?>) s);
                    if (m != null) {
                        out.add(m);
                    }
                } else if (s instanceof TextShape) {
                    Map<String, Object> m = textShape((TextShape<?, ?>) s);
                    if (m != null) {
                        out.add(m);
                    }
                } else if (s instanceof SimpleShape) {
                    // 无文本的纯色块（分隔条/装饰图形）：保留位置与填充
                    Map<String, Object> m = textShapeFromSimple((SimpleShape<?, ?>) s);
                    if (m != null) {
                        out.add(m);
                    }
                }
            } catch (Exception e) {
                // 单形状解析失败跳过，不影响整页其余形状
            }
        }
        return out;
    }

    /* ---------------- 各类形状 → 模型 ---------------- */

    private static Map<String, Object> textShape(TextShape<?, ?> ts) {
        Map<String, Object> m = textShapeFromSimple(ts);
        if (m == null) {
            return null;
        }
        List<Map<String, Object>> paras = new ArrayList<>();
        for (TextParagraph<?, ?, ?> p : ts.getTextParagraphs()) {
            List<Map<String, Object>> runs = runsOf(p);
            if (runs.isEmpty()) {
                continue;
            }
            Map<String, Object> pm = new LinkedHashMap<>();
            try {
                TextParagraph.TextAlign a = p.getTextAlign();
                pm.put("align", a == null ? null : a.toString());
            } catch (Exception e) {
                pm.put("align", null);
            }
            pm.put("bullet", bulletOf(p));
            try {
                pm.put("level", p.getIndentLevel());
            } catch (Exception e) {
                pm.put("level", 0);
            }
            pm.put("runs", runs);
            paras.add(pm);
        }
        m.put("paras", paras);
        // 文本垂直对齐（占位符封面页常居中）
        try {
            VerticalAlignment va = ts.getVerticalAlignment();
            m.put("valign", va == null ? null : va.toString());
        } catch (Exception e) {
            m.put("valign", null);
        }
        return m;
    }

    private static List<Map<String, Object>> runsOf(TextParagraph<?, ?, ?> p) {
        List<Map<String, Object>> runs = new ArrayList<>();
        for (TextRun r : p.getTextRuns()) {
            String raw = r.getRawText();
            if (raw == null || raw.isEmpty()) {
                continue;
            }
            Map<String, Object> rm = new LinkedHashMap<>();
            rm.put("x", raw.length() > 2000 ? raw.substring(0, 2000) : raw);
            try {
                Double fs = r.getFontSize();
                rm.put("size", fs == null ? null : Math.round(fs * 100) / 100.0);
            } catch (Exception e) {
                rm.put("size", null);
            }
            try {
                rm.put("bold", r.isBold());
            } catch (Exception e) {
                rm.put("bold", false);
            }
            try {
                rm.put("italic", r.isItalic());
            } catch (Exception e) {
                rm.put("italic", false);
            }
            rm.put("color", paintColor(r.getFontColor()));
            try {
                rm.put("font", r.getFontFamily());
            } catch (Exception e) {
                rm.put("font", null);
            }
            runs.add(rm);
        }
        return runs;
    }

    private static Map<String, Object> textShapeFromSimple(SimpleShape<?, ?> ss) {
        Rectangle2D anc = ss.getAnchor();
        if (anc == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "text");
        m.put("x", anc.getX());
        m.put("y", anc.getY());
        m.put("w", anc.getWidth());
        m.put("h", anc.getHeight());
        m.put("fill", fillColor(ss));
        m.put("round", isRounded(ss));
        try {
            var ins = ((TextShape<?, ?>) ss).getInsets();
            m.put("insetL", ins.left);
            m.put("insetR", ins.right);
            m.put("insetT", ins.top);
            m.put("insetB", ins.bottom);
        } catch (Exception e) {
            m.put("insetL", 7.2);
            m.put("insetR", 7.2);
            m.put("insetT", 3.6);
            m.put("insetB", 3.6);
        }
        return m;
    }

    private static Map<String, Object> tableShape(TableShape<?, ?> tb) {
        Map<String, Object> m = new LinkedHashMap<>();
        Rectangle2D anc = tb.getAnchor();
        if (anc != null) {
            m.put("x", anc.getX());
            m.put("y", anc.getY());
            m.put("w", anc.getWidth());
            m.put("h", anc.getHeight());
        }
        m.put("t", "table");
        List<Map<String, Object>> rows = new ArrayList<>();
        int rn = 0;
        try {
            int nr = tb.getNumberOfRows();
            int nc = tb.getNumberOfColumns();
            for (int r = 0; r < nr; r++) {
                Map<String, Object> rm = new LinkedHashMap<>();
                try {
                    rm.put("h", tb.getRowHeight(r));
                } catch (Exception e) {
                    rm.put("h", null);
                }
                List<Map<String, Object>> cells = new ArrayList<>();
                for (int c = 0; c < nc; c++) {
                    TableCell<?, ?> cell;
                    try {
                        cell = (TableCell<?, ?>) tb.getCell(r, c);
                    } catch (Exception e) {
                        continue;
                    }
                    if (cell == null || rn > 200) {
                        continue;
                    }
                    Map<String, Object> cm = new LinkedHashMap<>();
                    Rectangle2D ca = cell.getAnchor();
                    if (ca != null) {
                        cm.put("x", ca.getX());
                        cm.put("y", ca.getY());
                        cm.put("w", ca.getWidth());
                        cm.put("h", ca.getHeight());
                    }
                    cm.put("fill", fillColor(cell));
                    List<Map<String, Object>> paras = new ArrayList<>();
                    for (TextParagraph<?, ?, ?> p : cell.getTextParagraphs()) {
                        List<Map<String, Object>> runs = runsOf(p);
                        if (runs.isEmpty()) {
                            continue;
                        }
                        Map<String, Object> pm = new LinkedHashMap<>();
                        try {
                            TextParagraph.TextAlign a = p.getTextAlign();
                            pm.put("align", a == null ? null : a.toString());
                        } catch (Exception e) {
                            pm.put("align", null);
                        }
                        pm.put("runs", runs);
                        paras.add(pm);
                    }
                    cm.put("paras", paras);
                    cells.add(cm);
                }
                rm.put("cells", cells);
                rows.add(rm);
                rn++;
            }
        } catch (Exception e) {
            // 表格整体失败则保留骨架
        }
        m.put("rows", rows);
        return m;
    }

    private static Map<String, Object> pictureShape(PictureShape<?, ?> ps) {
        PictureData pd;
        try {
            pd = ps.getPictureData();
        } catch (Exception e) {
            return null;
        }
        if (pd == null) {
            return null;
        }
        String src = imageData(pd);
        if (src == null) {
            return null;
        }
        Rectangle2D anc = ps.getAnchor();
        if (anc == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "pic");
        m.put("x", anc.getX());
        m.put("y", anc.getY());
        m.put("w", anc.getWidth());
        m.put("h", anc.getHeight());
        m.put("src", src);
        return m;
    }

    /* ---------------- 样式辅助 ---------------- */

    private static String fillColor(SimpleShape<?, ?> ss) {
        try {
            PaintStyle paint = ss.getFillStyle().getPaint();
            if (paint instanceof PaintStyle.SolidPaint) {
                return colorHex(((PaintStyle.SolidPaint) paint).getSolidColor().getColor());
            }
        } catch (Exception e) { // 未设置填充/主题填充取不到 → 透明
        }
        return null;
    }

    private static String paintColor(PaintStyle paint) {
        if (paint instanceof PaintStyle.SolidPaint) {
            return colorHex(((PaintStyle.SolidPaint) paint).getSolidColor().getColor());
        }
        return null;
    }

    private static String colorHex(java.awt.Color c) {
        if (c == null) {
            return null;
        }
        return String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue());
    }

    /** 项目符号开关：XSLF/HSLF 各自实现（isBullet），通用接口未暴露 */
    private static boolean bulletOf(TextParagraph<?, ?, ?> p) {
        try {
            if (p instanceof org.apache.poi.xslf.usermodel.XSLFTextParagraph x) {
                return x.isBullet();
            }
            if (p instanceof org.apache.poi.hslf.usermodel.HSLFTextParagraph h) {
                return h.isBullet();
            }
        } catch (Exception e) {
            return false;
        }
        return false;
    }

    private static boolean isRounded(SimpleShape<?, ?> ss) {
        try {
            ShapeType st = ss.getShapeType();
            if (st == null) {
                return false;
            }
            String n = st.name();
            return n.startsWith("ROUND");
        } catch (Exception e) {
            return false;
        }
    }

    /** 图片 → dataURL；大图降采样（宽 ≤900px）控制 JSON 体积；EMF/WMF 等浏览器不支持格式跳过 */
    private static String imageData(PictureData pd) {
        try {
            if (pd == null) {
                return null;
            }
            return imageData(pd.getData(), pd.getContentType());
        } catch (Exception e) {
            return null;
        }
    }

    /** 通用图片 → dataURL（Word 文档解析复用）；大图降采样控制体积，浏览器不支持的图元跳过 */
    static String imageData(byte[] data, String contentType) {
        try {
            String ct = contentType == null ? null : contentType.toLowerCase();
            byte[] bytes = data;
            if (ct == null || bytes == null || bytes.length == 0) {
                return null;
            }
            if (!ct.startsWith("image/") || ct.contains("emf") || ct.contains("wmf")) {
                return null;
            }
            if (bytes.length > IMG_DOWNSCALE_BYTES) {
                BufferedImage img = ImageIO.read(new ByteArrayInputStream(bytes));
                if (img != null && img.getWidth() > IMG_DOWNSCALE_WIDTH) {
                    double scale = IMG_DOWNSCALE_WIDTH / (double) img.getWidth();
                    int w = IMG_DOWNSCALE_WIDTH;
                    int h = Math.max(1, (int) Math.round(img.getHeight() * scale));
                    boolean alpha = img.getColorModel().hasAlpha();
                    BufferedImage small = new BufferedImage(w, h,
                            alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
                    Graphics2D g = small.createGraphics();
                    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    g.drawImage(img, 0, 0, w, h, null);
                    g.dispose();
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    if (alpha) {
                        ImageIO.write(small, "png", bos);
                        ct = "image/png";
                    } else {
                        ImageIO.write(small, "jpg", bos);
                        ct = "image/jpeg";
                    }
                    bytes = bos.toByteArray();
                }
            }
            return "data:" + ct + ";base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (Exception e) {
            return null;
        }
    }
}
