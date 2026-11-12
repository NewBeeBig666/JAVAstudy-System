package com.la.service;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.PDFRenderer;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 「PDF 版面还原预览」解析器：pdf → 前端可渲染的页面图片模型 JSON。
 * 与 Word/PPT 版面还原同一思路：PDFBox 将每页按原版式渲染为位图（宽度封顶 850px，
 * 保证文字清晰且体积可控），前端在自有滚动容器内逐页渲染——从而复用与 Word
 * 完全一致的「滚动覆盖 ≥98%」学习进度口径（原生 iframe 内部滚动无法监听）。
 *
 * 模型结构：{ pages: [{ src(dataURL), w, h }] }
 * 解析失败由调用方回落浏览器原生直显（时长兜底口径）。
 */
public final class PdfPageParser {

    private PdfPageParser() {
    }

    private static final int MAX_PAGES = 60;
    private static final int MAX_W = 850;
    private static final float RENDER_DPI = 108;

    public static Map<String, Object> parse(Path file) throws Exception {
        try (PDDocument doc = PDDocument.load(Files.readAllBytes(file))) {
            PDFRenderer renderer = new PDFRenderer(doc);
            int total = Math.min(doc.getNumberOfPages(), MAX_PAGES);
            List<Map<String, Object>> pages = new ArrayList<>(total);
            for (int i = 0; i < total; i++) {
                // 108dpi 基准；超宽页面（如横幅图纸）按页宽封顶 850px 等比缩放
                float wPt = Math.max(1f, doc.getPage(i).getMediaBox().getWidth());
                float scale = Math.min(RENDER_DPI / 72f, MAX_W / wPt);
                BufferedImage img = renderer.renderImage(i, scale);
                if (img == null) {
                    continue;
                }
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                ImageIO.write(img, "png", bos);
                String src = "data:image/png;base64,"
                        + Base64.getEncoder().encodeToString(bos.toByteArray());
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("src", src);
                p.put("w", img.getWidth());
                p.put("h", img.getHeight());
                pages.add(p);
            }
            if (pages.isEmpty()) {
                throw new IllegalStateException("PDF 未渲染出任何页面");
            }
            Map<String, Object> model = new LinkedHashMap<>();
            model.put("pages", pages);
            return model;
        }
    }
}
