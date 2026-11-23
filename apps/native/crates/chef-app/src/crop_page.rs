//! Cắt lề và đổi khổ trang PDF (TASKS_RUST R5.05, FEATURES C7): dựng tham số `page.crop` và
//! `page.resize`. Chỉ đặt CropBox/khổ, nội dung giữ nguyên; lõi làm việc và hoàn tác theo revision.
// Trả `Value` thay vì struct sinh: typify gộp nhầm enum `Mode`/`Fit` giữa các operation nên
// `FileSplitParams`, `PageCropParams`, `PageResizeParams` không đọc lại được JSON hợp lệ (xem TASKS_RUST).
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    All,
    Odd,
    Even,
    /// Chỉ số trang từ 0.
    Pages(Vec<i64>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum CropMethod {
    /// Cắt từ mép trang hiển thị, mm: trên, dưới, trái, phải.
    Margins {
        top: f64,
        bottom: f64,
        left: f64,
        right: f64,
    },
    /// x0, y0, x1, y1 theo pt.
    Box([f64; 4]),
    /// Tự dò lề trắng.
    AutoTrim,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PageSize {
    A3,
    A4,
    Letter,
    Custom { width_mm: f64, height_mm: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    EmptyPages,
    NegativePage,
    BadMargin,
    BadBox,
    BadSize,
}

fn scope_json(o: &mut serde_json::Map<String, Value>, scope: &Scope) -> Result<(), Reject> {
    match scope {
        Scope::All => o.insert("scope".into(), "all".into()),
        Scope::Odd => o.insert("scope".into(), "odd".into()),
        Scope::Even => o.insert("scope".into(), "even".into()),
        Scope::Pages(p) => {
            if p.is_empty() {
                return Err(Reject::EmptyPages);
            }
            if p.iter().any(|&i| i < 0) {
                return Err(Reject::NegativePage);
            }
            o.insert("scope".into(), "pages".into());
            o.insert("pages".into(), json!(p))
        }
    };
    Ok(())
}

pub fn crop_params(scope: &Scope, method: &CropMethod, mediabox: bool) -> Result<Value, Reject> {
    let mut v = json!({ "mode": if mediabox { "mediabox" } else { "cropbox" } });
    let o = v.as_object_mut().expect("object");
    scope_json(o, scope)?;
    match method {
        CropMethod::Margins {
            top,
            bottom,
            left,
            right,
        } => {
            if [top, bottom, left, right]
                .iter()
                .any(|m| !m.is_finite() || **m < 0.0 || **m > 2000.0)
            {
                return Err(Reject::BadMargin);
            }
            o.insert(
                "margins".into(),
                json!({ "top": top, "bottom": bottom, "left": left, "right": right }),
            );
        }
        CropMethod::Box(b) => {
            if b.iter().any(|x| !x.is_finite()) || b[2] <= b[0] || b[3] <= b[1] {
                return Err(Reject::BadBox);
            }
            o.insert("box".into(), json!(b));
        }
        CropMethod::AutoTrim => {
            o.insert("autoTrim".into(), true.into());
        }
    }
    Ok(v)
}

pub fn resize_params(scope: &Scope, size: &PageSize, center_only: bool) -> Result<Value, Reject> {
    let mut v = json!({ "fit": if center_only { "center" } else { "scale" } });
    let o = v.as_object_mut().expect("object");
    scope_json(o, scope)?;
    match size {
        PageSize::A3 => o.insert("size".into(), "A3".into()),
        PageSize::A4 => o.insert("size".into(), "A4".into()),
        PageSize::Letter => o.insert("size".into(), "Letter".into()),
        PageSize::Custom {
            width_mm,
            height_mm,
        } => {
            let ok = |x: &f64| x.is_finite() && *x > 0.0 && *x <= 2000.0;
            if !ok(width_mm) || !ok(height_mm) {
                return Err(Reject::BadSize);
            }
            o.insert("size".into(), "custom".into());
            o.insert("customWidthMm".into(), (*width_mm).into());
            o.insert("customHeightMm".into(), (*height_mm).into())
        }
    };
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_methods() {
        let m = CropMethod::Margins {
            top: 5.0,
            bottom: 5.0,
            left: 10.0,
            right: 10.0,
        };
        let j = crop_params(&Scope::All, &m, false).unwrap();
        assert_eq!(j["margins"]["left"], 10.0);
        assert_eq!(j["mode"], "cropbox");
        let j = crop_params(&Scope::Pages(vec![0, 2]), &CropMethod::AutoTrim, true).unwrap();
        assert_eq!(j["autoTrim"], true);
        assert_eq!(j["mode"], "mediabox");
        assert_eq!(j["pages"], json!([0, 2]));
        assert!(crop_params(&Scope::Odd, &CropMethod::Box([0.0, 0.0, 10.0, 10.0]), false).is_ok());
    }

    #[test]
    fn crop_rejects() {
        assert_eq!(
            crop_params(&Scope::Pages(vec![]), &CropMethod::AutoTrim, false).unwrap_err(),
            Reject::EmptyPages
        );
        assert_eq!(
            crop_params(&Scope::Pages(vec![-1]), &CropMethod::AutoTrim, false).unwrap_err(),
            Reject::NegativePage
        );
        assert_eq!(
            crop_params(&Scope::All, &CropMethod::Box([5.0, 0.0, 5.0, 9.0]), false).unwrap_err(),
            Reject::BadBox
        );
        let neg = CropMethod::Margins {
            top: -1.0,
            bottom: 0.0,
            left: 0.0,
            right: 0.0,
        };
        assert_eq!(
            crop_params(&Scope::All, &neg, false).unwrap_err(),
            Reject::BadMargin
        );
    }

    #[test]
    fn resize_sizes() {
        for (s, name) in [
            (PageSize::A3, "A3"),
            (PageSize::A4, "A4"),
            (PageSize::Letter, "Letter"),
        ] {
            let j = resize_params(&Scope::Even, &s, false).unwrap();
            assert_eq!(j["size"], name);
            assert_eq!(j["fit"], "scale");
        }
        let c = PageSize::Custom {
            width_mm: 100.0,
            height_mm: 150.0,
        };
        let j = resize_params(&Scope::All, &c, true).unwrap();
        assert_eq!(j["customWidthMm"], 100.0);
        assert_eq!(j["fit"], "center");
        let bad = PageSize::Custom {
            width_mm: 0.0,
            height_mm: 10.0,
        };
        assert_eq!(
            resize_params(&Scope::All, &bad, false).unwrap_err(),
            Reject::BadSize
        );
    }
}
