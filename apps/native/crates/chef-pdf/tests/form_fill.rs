//! Real PDFium integration tests for R4.21 form-fill FFI, widget extraction, rendering, and
//! JS/XFA suppression. Builds minimal valid PDFs in pure Rust without requiring external fixtures.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;

use chef_pdf::form_fill::{DocFormInfo, FormType, PageWidgets, WidgetKind};
use chef_pdf::render::{self, Job, PageImage, RenderHandle, Reply};

struct TempPdf {
    dir: PathBuf,
    path: PathBuf,
}

impl TempPdf {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "chef-pdf-form-test-{}-{}-{nanos}",
            std::process::id(),
            name
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.pdf"));
        fs::write(&path, bytes).unwrap();
        Self { dir, path }
    }
}

impl Drop for TempPdf {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn dll_dir() -> PathBuf {
    std::env::var("CHEF_PDFIUM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../third_party/pdfium")
        })
}

fn spawn_pdfium() -> RenderHandle {
    render::spawn(dll_dir()).expect("nạp pdfium thất bại")
}

fn call<R>(
    h: &RenderHandle,
    make: impl FnOnce(u64, std::sync::mpsc::Sender<Reply<R>>) -> Job,
) -> R {
    let (tx, rx) = channel();
    let id = h.next_id();
    h.send(make(id, tx)).unwrap();
    let reply = rx.recv().unwrap();
    assert_eq!(reply.id, id);
    reply.result.unwrap()
}

fn open(h: &RenderHandle, path: &Path) -> u64 {
    let p = path.to_path_buf();
    call(h, |id, reply| Job::Open {
        id,
        path: p,
        password: None,
        reply,
    })
}

fn close(h: &RenderHandle, doc: u64) {
    call(h, |id, reply| Job::Close { id, doc, reply });
}

fn assemble_pdf(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::from(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".as_slice());
    let mut offsets = Vec::with_capacity(objects.len() + 1);
    offsets.push(0usize);
    for (idx, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        writeln!(out, "{} 0 obj", idx + 1).unwrap();
        out.extend_from_slice(body);
        if !body.ends_with(b"\n") {
            out.push(b'\n');
        }
        out.extend_from_slice(b"endobj\n");
    }
    let xref_pos = out.len();
    writeln!(out, "xref").unwrap();
    writeln!(out, "0 {}", objects.len() + 1).unwrap();
    writeln!(out, "0000000000 65535 f ").unwrap();
    for &off in &offsets[1..] {
        writeln!(out, "{off:010} 00000 n ").unwrap();
    }
    writeln!(out, "trailer").unwrap();
    writeln!(out, "<< /Size {} /Root 1 0 R >>", objects.len() + 1).unwrap();
    writeln!(out, "startxref").unwrap();
    writeln!(out, "{xref_pos}").unwrap();
    writeln!(out, "%%EOF").unwrap();
    out
}

fn build_plain_pdf() -> Vec<u8> {
    let objs = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>".to_vec(),
    ];
    assemble_pdf(&objs)
}

fn build_signed_pdf() -> Vec<u8> {
    let objs = vec![
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [4 0 R] >>".to_vec(),
        b"<< /Type /Annot /Subtype /Widget /F 132 /P 3 0 R /FT /Sig /T (Signature1) /V 5 0 R /Rect [20 20 140 50] >>".to_vec(),
        b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Contents <000102030405060708090a0b0c0d0e0f> /ByteRange [0 0 0 0] >>".to_vec(),
    ];
    assemble_pdf(&objs)
}

/// Builds a rich AcroForm PDF with text, multiline, comb, checkbox (checked + unchecked),
/// radio group (checked + all-off), dropdown, signature, CropBox, and Rotate support.
fn build_form_pdf(rotate: i32, crop_box: Option<[f32; 4]>, radio_checked: bool) -> Vec<u8> {
    // 1: Catalog, 2: Pages, 3: Page, 4: AcroForm, 5: Font Helv,
    // 6: text "hoten", 7: multiline "ghichu", 8: comb "cmnd",
    // 9: checkbox "dongy" (checked), 10: checkbox "nhantin" (unchecked),
    // 11: radio parent "gioitinh", 12: radio kid "nam", 13: radio kid "nu",
    // 14: dropdown "tinh", 15: signature "chuky",
    // 16: blue-box AP stream (on), 17: empty AP stream (off)
    let crop = crop_box.map_or(String::new(), |c| {
        format!(" /CropBox [{} {} {} {}]", c[0], c[1], c[2], c[3])
    });
    let radio_v = if radio_checked { "/nam" } else { "/Off" };
    let nam_as = if radio_checked { "/nam" } else { "/Off" };
    let ap_on_body = b"0.1 0.3 0.9 rg 1 1 12 12 re f";
    let ap_on = format!(
        "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length {} >>\nstream\n{}\nendstream",
        ap_on_body.len(),
        std::str::from_utf8(ap_on_body).unwrap()
    );
    let ap_off =
        "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream";

    let objs = vec![
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400]{crop} /Rotate {rotate} /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 12 0 R 13 0 R 14 0 R 15 0 R] >>"
        )
        .into_bytes(),
        b"<< /Fields [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 14 0 R 15 0 R] /DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 12 Tf 0 g) >>".to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        // 6: text
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /T (hoten) /V (Nguyen A) /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /Rect [20 260 180 280] >>".to_vec(),
        // 7: multiline (1 << 12 = 4096)
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /Ff 4096 /T (ghichu) /V (Line 1) /DA (/Helv 11 Tf 0 g) /Rect [20 200 220 245] >>".to_vec(),
        // 8: comb (1 << 24 = 16777216)
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /Ff 16777216 /MaxLen 9 /T (cmnd) /V (12345) /DA (/Helv 12 Tf 0 g) /Rect [20 170 200 190] >>".to_vec(),
        // 9: checkbox checked (with custom /AP on state /Yes)
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Btn /T (dongy) /V /Yes /AS /Yes /AP << /N << /Yes 16 0 R /Off 17 0 R >> >> /Rect [20 140 34 154] >>".to_vec(),
        // 10: checkbox unchecked
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Btn /T (nhantin) /V /Off /AS /Off /AP << /N << /Yes 16 0 R /Off 17 0 R >> >> /Rect [60 140 74 154] >>".to_vec(),
        // 11: radio group parent (Radio 1<<15 + NoToggleToOff 1<<14 = 49152)
        format!("<< /FT /Btn /Ff 49152 /T (gioitinh) /V {radio_v} /Kids [12 0 R 13 0 R] >>")
            .into_bytes(),
        // 12: radio kid nam
        format!("<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /Parent 11 0 R /AS {nam_as} /AP << /N << /nam 16 0 R /Off 17 0 R >> >> /Rect [20 110 34 124] >>")
            .into_bytes(),
        // 13: radio kid nu
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /Parent 11 0 R /AS /Off /AP << /N << /nu 16 0 R /Off 17 0 R >> >> /Rect [60 110 74 124] >>".to_vec(),
        // 14: dropdown (Combo 1<<17 = 131072) + Required (2)
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Ch /Ff 131074 /T (tinh) /V (HCM) /Opt [(HN) (HCM) (DN)] /DA (/Helv 12 Tf 0 g) /Rect [20 70 150 90] >>".to_vec(),
        // 15: signature (/FT /Sig) + ReadOnly (1)
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Sig /Ff 1 /T (chuky) /Rect [180 70 300 110] >>".to_vec(),
        ap_on.into_bytes(),
        ap_off.as_bytes().to_vec(),
    ];
    assemble_pdf(&objs)
}

fn build_js_attack_pdf() -> Vec<u8> {
    // Catalog /OpenAction JS + Page /AA /O JS + Widget /AA /C & /F JS trying to mutate "target".
    let objs = vec![
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R /OpenAction 7 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /AA << /O 7 0 R >> /Annots [6 0 R] >>".to_vec(),
        b"<< /Fields [6 0 R] /DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 12 Tf 0 g) >>".to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /T (target) /V (SAFE) /DA (/Helv 12 Tf 0 g) /AA << /C 7 0 R /F 7 0 R >> /Rect [20 200 180 225] >>".to_vec(),
        b"<< /Type /Action /S /JavaScript /JS (this.getField(\"target\").value = \"PWNED\"; app.alert(\"PWNED\");) >>".to_vec(),
    ];
    assemble_pdf(&objs)
}

fn build_xfa_pdf() -> Vec<u8> {
    let xfa_body = b"<xdp:xdp xmlns:xdp=\"http://ns.adobe.com/xdp/\"><template/></xdp:xdp>";
    let xfa_obj = format!(
        "<< /Length {} >>\nstream\n{}\nendstream",
        xfa_body.len(),
        std::str::from_utf8(xfa_body).unwrap()
    );
    let objs = vec![
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [6 0 R] >>".to_vec(),
        b"<< /Fields [6 0 R] /XFA 7 0 R /DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 12 Tf 0 g) >>".to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        b"<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /T (acro_name) /V (AcroOk) /DA (/Helv 12 Tf 0 g) /Rect [20 200 160 220] >>".to_vec(),
        xfa_obj.into_bytes(),
    ];
    assemble_pdf(&objs)
}

#[test]
fn form_env_initializes_on_form_pdfs_and_exits_on_close() {
    let h = spawn_pdfium();
    let plain_f = TempPdf::new("plain", &build_plain_pdf());
    let form_a = TempPdf::new("form_a", &build_form_pdf(0, None, true));
    let form_b = TempPdf::new("form_b", &build_form_pdf(0, None, false));

    let doc_plain = open(&h, &plain_f.path);
    let info_plain: DocFormInfo = call(&h, |id, reply| Job::FormInfo {
        id,
        doc: doc_plain,
        reply,
    });
    assert_eq!(info_plain.form_type, FormType::None);
    assert!(!info_plain.form_env_active);
    let s0 = h.form_env_stats();
    assert_eq!(s0.active_docs, 1);
    assert_eq!(s0.active_form_envs, 0);

    let doc_a = open(&h, &form_a.path);
    let doc_b = open(&h, &form_b.path);
    let info_a: DocFormInfo = call(&h, |id, reply| Job::FormInfo {
        id,
        doc: doc_a,
        reply,
    });
    assert_eq!(info_a.form_type, FormType::AcroForm);
    assert!(info_a.form_env_active);
    assert!(!info_a.js_enabled);
    assert!(!info_a.xfa_loaded);

    let s1 = h.form_env_stats();
    assert_eq!(s1.active_docs, 3);
    assert_eq!(s1.active_form_envs, 2);
    assert_eq!(s1.total_form_inits, 2);
    assert_eq!(s1.total_form_exits, 0);

    close(&h, doc_a);
    let s2 = h.form_env_stats();
    assert_eq!(s2.active_docs, 2);
    assert_eq!(s2.active_form_envs, 1);
    assert_eq!(s2.total_form_exits, 1);

    close(&h, doc_b);
    close(&h, doc_plain);
    let s3 = h.form_env_stats();
    assert_eq!(s3.active_docs, 0);
    assert_eq!(s3.active_form_envs, 0);
    assert_eq!(s3.total_form_inits, 2);
    assert_eq!(s3.total_form_exits, 2);
}

#[test]
fn reads_all_widget_kinds_and_coordinates_across_rotate_and_cropbox() {
    let h = spawn_pdfium();

    // 1. Standard 0 deg, checked radio = true
    let pdf0 = TempPdf::new("rot0", &build_form_pdf(0, None, true));
    let doc0 = open(&h, &pdf0.path);
    let pw0: PageWidgets = call(&h, |id, reply| Job::PageFormWidgets {
        id,
        doc: doc0,
        index: 0,
        reply,
    });
    assert_eq!(pw0.widgets.len(), 9);
    let by_idx = |i: usize| &pw0.widgets[i];

    assert_eq!(by_idx(0).name, "hoten");
    assert_eq!(by_idx(0).kind, WidgetKind::Text);
    assert_eq!(by_idx(0).value.as_deref(), Some("Nguyen A"));
    assert!((by_idx(0).rect.left - 20.0).abs() < 1e-2);
    assert!((by_idx(0).rect.top - 120.0).abs() < 1e-2); // 400 - 280 = 120

    assert_eq!(by_idx(1).kind, WidgetKind::Multiline);
    assert_eq!(by_idx(2).kind, WidgetKind::Comb);

    assert_eq!(by_idx(3).name, "dongy");
    assert_eq!(by_idx(3).kind, WidgetKind::Checkbox);
    assert_eq!(by_idx(3).checked, Some(true));

    assert_eq!(by_idx(4).name, "nhantin");
    assert_eq!(by_idx(4).kind, WidgetKind::Checkbox);
    assert_eq!(by_idx(4).checked, Some(false));

    assert_eq!(by_idx(5).name, "gioitinh");
    assert_eq!(by_idx(5).kind, WidgetKind::Radio);
    assert_eq!(by_idx(5).checked, Some(true));

    assert_eq!(by_idx(6).name, "gioitinh");
    assert_eq!(by_idx(6).kind, WidgetKind::Radio);
    assert_eq!(by_idx(6).checked, Some(false));

    assert_eq!(by_idx(7).name, "tinh");
    assert_eq!(by_idx(7).kind, WidgetKind::Dropdown);
    assert!(by_idx(7).required);
    assert_eq!(by_idx(7).options.len(), 3);
    assert!(by_idx(7).options.iter().any(|o| o.label == "HCM"));

    assert_eq!(by_idx(8).name, "chuky");
    assert_eq!(by_idx(8).kind, WidgetKind::Signature);
    assert!(by_idx(8).read_only);
    close(&h, doc0);

    // 2. Rotate 90 + CropBox [10 20 310 320] + both radio options unchecked (V=/Off, AS=/Off)
    let pdf90 = TempPdf::new(
        "rot90_crop",
        &build_form_pdf(90, Some([10.0, 20.0, 310.0, 320.0]), false),
    );
    let doc90 = open(&h, &pdf90.path);
    let pw90: PageWidgets = call(&h, |id, reply| Job::PageFormWidgets {
        id,
        doc: doc90,
        index: 0,
        reply,
    });
    assert_eq!(pw90.widgets[5].checked, Some(false));
    assert_eq!(pw90.widgets[6].checked, Some(false));
    // For hoten user rect [20, 260, 180, 280] inside crop [10, 20, 310, 320] (u: 10..170, v: 240..260),
    // rotated 90 CW: x' = v = [240, 260], y' = u = [10, 170].
    let r = pw90.widgets[0].rect;
    assert!(
        (r.left - 240.0).abs() < 1e-2
            && (r.top - 10.0).abs() < 1e-2
            && (r.right - 260.0).abs() < 1e-2
            && (r.bottom - 170.0).abs() < 1e-2,
        "rotated crop rect {r:?}"
    );
    close(&h, doc90);
}

#[test]
fn renders_form_widgets_into_page_bitmap_via_ffl_draw() {
    let h = spawn_pdfium();
    let pdf = TempPdf::new("render_widgets", &build_form_pdf(0, None, true));
    let doc = open(&h, &pdf.path);
    let widgets: PageWidgets = call(&h, |id, reply| Job::PageFormWidgets {
        id,
        doc,
        index: 0,
        reply,
    });
    let img: PageImage = call(&h, |id, reply| Job::Render {
        id,
        doc,
        index: 0,
        width: 400,
        height: 400,
        reply,
    });
    // Helper: count non-white pixels inside displayed rect (page size == pixel size 400x400).
    let non_white_in = |rect: chef_pdf::text::Rect| -> usize {
        let x0 = (rect.left.floor() as isize).max(0) as usize;
        let y0 = (rect.top.floor() as isize).max(0) as usize;
        let x1 = (rect.right.ceil() as isize).min(400) as usize;
        let y1 = (rect.bottom.ceil() as isize).min(400) as usize;
        let mut count = 0usize;
        for y in y0..y1 {
            for x in x0..x1 {
                let off = (y * 400 + x) * 4;
                if img.bgra[off] < 245 || img.bgra[off + 1] < 245 || img.bgra[off + 2] < 245 {
                    count += 1;
                }
            }
        }
        count
    };
    let dongy = &widgets.widgets[3]; // checked checkbox (blue AP box)
    let hoten = &widgets.widgets[0]; // text widget with border & text
    assert!(
        non_white_in(dongy.rect) > 50,
        "checked checkbox AP was not drawn by FPDF_FFLDraw"
    );
    assert!(
        non_white_in(hoten.rect) > 20,
        "text field widget border/value was not drawn by FPDF_FFLDraw"
    );
    close(&h, doc);
}

#[test]
fn javascript_actions_never_execute_in_form_fill_environment() {
    let h = spawn_pdfium();
    let pdf = TempPdf::new("js_attack", &build_js_attack_pdf());
    let doc = open(&h, &pdf.path);
    let info: DocFormInfo = call(&h, |id, reply| Job::FormInfo { id, doc, reply });
    assert!(!info.js_enabled);
    assert!(!info.xfa_loaded);

    let widgets: PageWidgets = call(&h, |id, reply| Job::PageFormWidgets {
        id,
        doc,
        index: 0,
        reply,
    });
    let target = widgets
        .widgets
        .iter()
        .find(|w| w.name == "target")
        .expect("missing target widget");
    assert_eq!(target.value.as_deref(), Some("SAFE"));

    let _img: PageImage = call(&h, |id, reply| Job::Render {
        id,
        doc,
        index: 0,
        width: 300,
        height: 300,
        reply,
    });
    let widgets_after: PageWidgets = call(&h, |id, reply| Job::PageFormWidgets {
        id,
        doc,
        index: 0,
        reply,
    });
    assert_eq!(widgets_after.widgets[0].value.as_deref(), Some("SAFE"));

    close(&h, doc);
    assert_eq!(h.form_env_stats().active_form_envs, 0);
}

#[test]
fn xfa_document_never_loads_xfa_or_js() {
    let h = spawn_pdfium();
    let pdf = TempPdf::new("xfa", &build_xfa_pdf());
    let doc = open(&h, &pdf.path);
    let info: DocFormInfo = call(&h, |id, reply| Job::FormInfo { id, doc, reply });
    assert!(!info.xfa_loaded);
    assert!(!info.js_enabled);
    let _img: PageImage = call(&h, |id, reply| Job::Render {
        id,
        doc,
        index: 0,
        width: 300,
        height: 300,
        reply,
    });
    close(&h, doc);
    assert_eq!(h.form_env_stats().active_form_envs, 0);
}

#[test]
fn has_signatures_distinguishes_signed_from_unsigned_sig_fields() {
    let h = spawn_pdfium();
    let plain_f = TempPdf::new("sig_plain", &build_plain_pdf());
    let unsigned_form_f = TempPdf::new("sig_unsigned_form", &build_form_pdf(0, None, true));
    let signed_f = TempPdf::new("sig_signed", &build_signed_pdf());

    let doc_plain = open(&h, &plain_f.path);
    let doc_unsigned = open(&h, &unsigned_form_f.path);
    let doc_signed = open(&h, &signed_f.path);

    let has_plain: bool = call(&h, |id, reply| Job::HasSignatures {
        id,
        doc: doc_plain,
        reply,
    });
    let has_unsigned: bool = call(&h, |id, reply| Job::HasSignatures {
        id,
        doc: doc_unsigned,
        reply,
    });
    let has_signed: bool = call(&h, |id, reply| Job::HasSignatures {
        id,
        doc: doc_signed,
        reply,
    });

    assert!(!has_plain, "plain PDF should not report signed");
    assert!(
        !has_unsigned,
        "form PDF with empty /FT /Sig field should not report signed"
    );
    assert!(
        has_signed,
        "PDF with signed /V /Sig dict must report signed"
    );

    close(&h, doc_plain);
    close(&h, doc_unsigned);
    close(&h, doc_signed);
    assert_eq!(h.form_env_stats().active_form_envs, 0);
}
