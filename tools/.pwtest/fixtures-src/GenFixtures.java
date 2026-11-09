import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xslf.usermodel.XSLFSlide;
import org.apache.poi.xslf.usermodel.XSLFTextBox;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFTable;

import java.awt.Rectangle;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 预览重构 E2E 测试文件生成器：用项目自带 POI/PDFBox 生成真实 docx（标题/列表/表格）、
 * pptx（2 页幻灯片）、pdf 各一份，供上传+预览链路测试使用。
 * 用法：java GenFixtures <输出目录>
 */
public class GenFixtures {
    public static void main(String[] args) throws Exception {
        Path out = Path.of(args.length > 0 ? args[0] : ".");
        Files.createDirectories(out);

        // ---------- docx：标题 1/2 + 段落 + 项目符号列表 + 2x2 表格 ----------
        try (XWPFDocument doc = new XWPFDocument()) {
            XWPFParagraph h1 = doc.createParagraph();
            h1.setStyle("Heading1");
            h1.createRun().setText("Java 集合框架概述");

            XWPFParagraph p1 = doc.createParagraph();
            p1.createRun().setText("集合框架是 Java 语言的基础设施，本节介绍其整体结构与选型。");

            XWPFParagraph h2 = doc.createParagraph();
            h2.setStyle("Heading2");
            h2.createRun().setText("常用实现类");

            // 项目符号列表（依赖 numbering 组件）
            try {
                org.apache.poi.xwpf.usermodel.XWPFNumbering numbering = doc.createNumbering();
                org.openxmlformats.schemas.wordprocessingml.x2006.main.CTAbstractNum ct =
                        org.openxmlformats.schemas.wordprocessingml.x2006.main.CTAbstractNum.Factory.newInstance();
                ct.setAbstractNumId(BigInteger.ZERO);
                org.openxmlformats.schemas.wordprocessingml.x2006.main.CTLvl lvl = ct.addNewLvl();
                lvl.setIlvl(BigInteger.ZERO);
                lvl.addNewNumFmt().setVal(org.openxmlformats.schemas.wordprocessingml.x2006.main.STNumberFormat.BULLET);
                lvl.addNewLvlText().setVal("•");
                BigInteger absId = numbering.addAbstractNum(new org.apache.poi.xwpf.usermodel.XWPFAbstractNum(ct));
                org.openxmlformats.schemas.wordprocessingml.x2006.main.CTNum ctNum =
                        org.openxmlformats.schemas.wordprocessingml.x2006.main.CTNum.Factory.newInstance();
                ctNum.setNumId(BigInteger.ONE);
                org.openxmlformats.schemas.wordprocessingml.x2006.main.CTDecimalNumber dec =
                        org.openxmlformats.schemas.wordprocessingml.x2006.main.CTDecimalNumber.Factory.newInstance();
                dec.setVal(absId == null ? BigInteger.ZERO : absId);
                ctNum.setAbstractNumId(dec);
                org.apache.poi.xwpf.usermodel.XWPFNum num = new org.apache.poi.xwpf.usermodel.XWPFNum(ctNum, numbering);
                numbering.addNum(num);
                BigInteger numId = num.getCTNum().getNumId();
                for (String s : new String[]{"ArrayList：动态数组，随机访问快", "LinkedList：双向链表，头尾插删快", "HashMap：哈希表，键值存取 O(1)"}) {
                    XWPFParagraph li = doc.createParagraph();
                    li.setNumID(numId);
                    li.createRun().setText(s);
                }
            } catch (Exception e) {
                // numbering 创建失败时退化为普通段落（不影响主流程）
                for (String s : new String[]{"ArrayList：动态数组", "LinkedList：双向链表", "HashMap：哈希表"}) {
                    doc.createParagraph().createRun().setText("· " + s);
                }
            }

            XWPFParagraph h2b = doc.createParagraph();
            h2b.setStyle("Heading2");
            h2b.createRun().setText("选型对比");

            XWPFTable t = doc.createTable(2, 2);
            t.getRow(0).getCell(0).setText("实现类");
            t.getRow(0).getCell(1).setText("适用场景");
            t.getRow(1).getCell(0).setText("ArrayList");
            t.getRow(1).getCell(1).setText("遍历与随机访问为主");

            try (FileOutputStream fos = new FileOutputStream(out.resolve("test-doc.docx").toFile())) {
                doc.write(fos);
            }
        }

        // ---------- pptx：2 页（每页标题 + 两行正文） ----------
        try (XMLSlideShow ppt = new XMLSlideShow()) {
            String[][] slides = {
                    {"PPT 原文预览验证 · 第 1 页", "标题下方第一行要点", "标题下方第二行要点"},
                    {"第 2 页 · 集合框架小结", "ArrayList 与 LinkedList 的取舍", "线程安全场景考虑 ConcurrentHashMap"}
            };
            for (String[] s : slides) {
                XSLFSlide slide = ppt.createSlide();
                XSLFTextBox tb = slide.createTextBox();
                tb.setAnchor(new Rectangle(80, 60, 600, 400));
                StringBuilder sb = new StringBuilder(s[0]);
                for (int i = 1; i < s.length; i++) {
                    sb.append('\n').append(s[i]);
                }
                tb.setText(sb.toString());
            }
            try (FileOutputStream fos = new FileOutputStream(out.resolve("test-slides.pptx").toFile())) {
                ppt.write(fos);
            }
        }

        // ---------- pdf：1 页文本（浏览器原生直显验证） ----------
        try (PDDocument pdf = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.A4);
            pdf.addPage(page);
            try (PDPageContentStream cs = new PDPageContentStream(pdf, page)) {
                cs.beginText();
                cs.setFont(PDType1Font.HELVETICA_BOLD, 20);
                cs.newLineAtOffset(80, 720);
                cs.showText("PDF Native Preview Test");
                cs.endText();
                cs.beginText();
                cs.setFont(PDType1Font.HELVETICA, 12);
                cs.newLineAtOffset(80, 690);
                cs.showText("This PDF is rendered by the browser built-in viewer.");
                cs.endText();
            }
            pdf.save(out.resolve("test-doc.pdf").toFile());
        }

        System.out.println("Fixtures generated at: " + out.toAbsolutePath());
    }
}
