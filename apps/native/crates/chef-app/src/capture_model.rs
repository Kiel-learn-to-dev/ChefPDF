//! Mô hình hộp thoại chụp bằng điện thoại (TASKS_RUST R8.07, R8.08, FEATURES L5, I19): port
//! `captureModel.ts`. Máy trạng thái (chờ → xem lại), danh sách ảnh theo thứ tự, kế hoạch xử lý sau
//! chụp. Logic thuần; máy chủ LAN thật nằm ở `chef-capture`.
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Starting,
    Waiting,
    Review,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Photo {
    /// Thứ tự đến của máy chủ (từ 0).
    pub index: u64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub phase: Phase,
    pub url: String,
    pub expires_at: Option<u64>,
    /// Ảnh theo thứ tự người dùng muốn trong PDF.
    pub photos: Vec<Photo>,
    pub error_code: Option<String>,
    pub notice: Option<String>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            url: String::new(),
            expires_at: None,
            photos: Vec::new(),
            error_code: None,
            notice: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Starting,
    Started {
        url: String,
        expires_at: u64,
    },
    Failed(String),
    /// Ảnh mới từ điện thoại.
    Image(Photo),
    /// Trạng thái phiên: "active", "done", "stopped", "expired".
    Status(String),
    Move {
        from: usize,
        to: usize,
    },
    Remove(u64),
    Reset,
}

/// Thêm ảnh một lần, giữ thứ tự máy chủ.
pub fn add_photo(photos: &[Photo], photo: Photo) -> Vec<Photo> {
    let mut v = photos.to_vec();
    if !v.iter().any(|p| p.index == photo.index) {
        v.push(photo);
        v.sort_by_key(|p| p.index);
    }
    v
}

/// Chuyển phần tử `from` đến vị trí `to`; chỉ số ngoài phạm vi thì không đổi.
pub fn reorder(photos: &[Photo], from: usize, to: usize) -> Vec<Photo> {
    let mut v = photos.to_vec();
    if from < v.len() && to < v.len() && from != to {
        let item = v.remove(from);
        v.insert(to, item);
    }
    v
}

pub fn reduce(state: &Model, action: Action) -> Model {
    match action {
        Action::Starting => Model {
            phase: Phase::Starting,
            ..Model::default()
        },
        Action::Started { url, expires_at } => Model {
            phase: Phase::Waiting,
            url,
            expires_at: Some(expires_at),
            ..Model::default()
        },
        Action::Failed(code) => Model {
            phase: Phase::Error,
            error_code: Some(code),
            ..Model::default()
        },
        Action::Move { from, to } => Model {
            photos: reorder(&state.photos, from, to),
            ..state.clone()
        },
        Action::Remove(index) => Model {
            photos: state
                .photos
                .iter()
                .filter(|p| p.index != index)
                .cloned()
                .collect(),
            ..state.clone()
        },
        Action::Reset => Model::default(),
        // Ảnh chỉ nhận khi điện thoại đang kết nối phiên.
        Action::Image(photo) => {
            if state.phase != Phase::Waiting {
                return state.clone();
            }
            Model {
                photos: add_photo(&state.photos, photo),
                ..state.clone()
            }
        }
        Action::Status(s) => {
            if state.phase != Phase::Waiting || s == "active" {
                return state.clone();
            }
            let has = !state.photos.is_empty();
            if s == "expired" {
                return if has {
                    Model {
                        phase: Phase::Review,
                        notice: Some("EXPIRED".into()),
                        ..state.clone()
                    }
                } else {
                    Model {
                        phase: Phase::Error,
                        error_code: Some("EXPIRED".into()),
                        ..Model::default()
                    }
                };
            }
            // done (điện thoại bấm Xong) hoặc stopped (máy tính bấm Xong/hủy).
            if has {
                Model {
                    phase: Phase::Review,
                    notice: None,
                    ..state.clone()
                }
            } else {
                Model::default()
            }
        }
    }
}

/// Khóa chuỗi giao diện của mã lỗi.
pub fn error_key(code: Option<&str>) -> &'static str {
    match code {
        Some("NO_LAN_INTERFACE") => "capture.errNoLan",
        Some("INTERFACE_NOT_FOUND") => "capture.errNoInterface",
        Some("EXPIRED") => "capture.errExpired",
        _ => "capture.errGeneric",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// Tự cắt và nắn thẳng từng trang.
    pub auto_crop: bool,
    /// Tách trang đôi của sách mở.
    pub split_spread: bool,
    /// Làm trắng nền.
    pub whiten: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            auto_crop: true,
            split_spread: false,
            whiten: false,
        }
    }
}

/// `convert.imagesToPdf`: mỗi ảnh một trang, khổ trang bằng khổ ảnh.
pub fn pdf_params(paths: &[String], output_path: &str) -> Value {
    json!({
        "images": paths, "outputPath": output_path, "pageSize": "fit-image",
        "marginMm": 0, "orientation": "auto", "fit": "fit",
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedOp {
    pub op_id: &'static str,
    pub params: Value,
    pub title: &'static str,
}

/// Thao tác chạy trên tài liệu mới, theo thứ tự. Cắt trước khi tách: khe gáy chỉ tìm được khi ảnh đã
/// cắt đúng quyển sách mở (D39).
pub fn plan(o: Options) -> Vec<PlannedOp> {
    let mut v = Vec::new();
    if o.auto_crop {
        v.push(PlannedOp {
            op_id: "pageimg.autoCrop",
            params: json!({"minConfidence": 0.6}),
            title: "crop",
        });
    }
    if o.split_spread {
        v.push(PlannedOp {
            op_id: "pageimg.splitSpread",
            params: json!({"mode": "auto"}),
            title: "split",
        });
    }
    if o.auto_crop {
        v.push(PlannedOp {
            op_id: "pageimg.deskew",
            params: json!({"mode": "auto"}),
            title: "deskew",
        });
    }
    if o.whiten {
        v.push(PlannedOp {
            op_id: "pageimg.enhance",
            params: json!({"whiten": true}),
            title: "whiten",
        });
    }
    v
}

/// Chỉ số trang (từ 0) lõi đánh dấu cần xem lại (`data.needsReview` của autoCrop).
pub fn review_pages(data: &Value) -> Vec<u64> {
    data.get("needsReview")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ph(i: u64) -> Photo {
        Photo {
            index: i,
            path: format!("/c/{i}.jpg"),
        }
    }
    fn waiting() -> Model {
        reduce(
            &Model::default(),
            Action::Started {
                url: "http://192.168.1.5:8080/x".into(),
                expires_at: 99,
            },
        )
    }

    #[test]
    fn photos_only_while_waiting_and_deduped_in_server_order() {
        let idle = reduce(&Model::default(), Action::Image(ph(0)));
        assert!(idle.photos.is_empty());
        let mut m = waiting();
        for i in [2, 0, 1, 1] {
            m = reduce(&m, Action::Image(ph(i)));
        }
        assert_eq!(
            m.photos.iter().map(|p| p.index).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        m = reduce(&m, Action::Move { from: 2, to: 0 });
        assert_eq!(
            m.photos.iter().map(|p| p.index).collect::<Vec<_>>(),
            [2, 0, 1]
        );
        m = reduce(&m, Action::Move { from: 9, to: 0 });
        assert_eq!(m.photos.len(), 3);
        m = reduce(&m, Action::Remove(0));
        assert_eq!(m.photos.len(), 2);
    }

    #[test]
    fn status_transitions() {
        let m = waiting();
        assert_eq!(reduce(&m, Action::Status("active".into())), m);
        // xong mà chưa có ảnh: về trạng thái đầu
        assert_eq!(reduce(&m, Action::Status("done".into())), Model::default());
        // hết hạn mà chưa có ảnh: lỗi
        let e = reduce(&m, Action::Status("expired".into()));
        assert_eq!(
            (e.phase, e.error_code.as_deref()),
            (Phase::Error, Some("EXPIRED"))
        );
        let with = reduce(&m, Action::Image(ph(0)));
        let r = reduce(&with, Action::Status("done".into()));
        assert_eq!((r.phase, r.notice), (Phase::Review, None));
        let r = reduce(&with, Action::Status("expired".into()));
        assert_eq!(
            (r.phase, r.notice.as_deref()),
            (Phase::Review, Some("EXPIRED"))
        );
        // ngoài trạng thái chờ thì bỏ qua
        assert_eq!(reduce(&r, Action::Status("done".into())), r);
        assert_eq!(
            reduce(&with, Action::Failed("NO_LAN_INTERFACE".into())).phase,
            Phase::Error
        );
        assert_eq!(error_key(Some("NO_LAN_INTERFACE")), "capture.errNoLan");
        assert_eq!(error_key(Some("???")), "capture.errGeneric");
        assert_eq!(error_key(None), "capture.errGeneric");
    }

    #[test]
    fn plan_crops_before_splitting_and_params() {
        let ids = |o| plan(o).iter().map(|p| p.op_id).collect::<Vec<_>>();
        assert_eq!(
            ids(Options::default()),
            ["pageimg.autoCrop", "pageimg.deskew"]
        );
        assert_eq!(
            ids(Options {
                auto_crop: true,
                split_spread: true,
                whiten: true
            }),
            [
                "pageimg.autoCrop",
                "pageimg.splitSpread",
                "pageimg.deskew",
                "pageimg.enhance"
            ]
        );
        assert!(
            ids(Options {
                auto_crop: false,
                split_spread: false,
                whiten: false
            })
            .is_empty()
        );
        let p = pdf_params(&["/a.jpg".into()], "/o.pdf");
        assert_eq!(
            (p["pageSize"].as_str(), p["marginMm"].as_i64()),
            (Some("fit-image"), Some(0))
        );
        assert_eq!(
            review_pages(&json!({"needsReview":[3, -1, 1.5, "x", 0]})),
            [3, 0]
        );
        assert!(review_pages(&Value::Null).is_empty());
    }
}
