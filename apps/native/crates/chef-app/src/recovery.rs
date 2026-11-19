//! Khôi phục phiên làm việc sau khi ứng dụng hoặc lõi dừng đột ngột (TASKS_RUST R3.13).
//!
//! Bất biến R3.03: hàm [`has_unclosed_sessions`] kiểm tra trực tiếp thư mục `sessions` bằng Rust thuần;
//! nếu không có phiên chưa đóng thì tuyệt đối không chạm tới `Supervisor` hay khởi động `chef-core`.

use std::fs;
use std::path::Path;

use chef_theme::{dark, light, shared};
use chef_ui::button::{Button, Size, Variant, pack};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::i18n;
use gpui::{
    App, Context, ElementId, Entity, FocusHandle, FontWeight, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div, px, rgba,
};
use serde_json::Value;

/// Một phiên chưa đóng có thể khôi phục từ đĩa.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoverableSession {
    pub session_id: String,
    pub source_path: Option<String>,
    pub opened_at: Option<String>,
    pub last_modified: String,
    pub revision: Option<u64>,
    pub dirty: bool,
    pub pages: Option<u64>,
    pub has_unsaved_changes: bool,
}

impl RecoverableSession {
    pub fn from_json(value: &Value) -> Option<Self> {
        let session_id = value.get("sessionId")?.as_str()?.to_string();
        let source_path = value
            .get("sourcePath")
            .and_then(Value::as_str)
            .map(str::to_string);
        let opened_at = value
            .get("openedAt")
            .and_then(Value::as_str)
            .map(str::to_string);
        let last_modified = value
            .get("lastModified")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let revision = value.get("revision").and_then(Value::as_u64);
        let dirty = value.get("dirty").and_then(Value::as_bool).unwrap_or(false);
        let pages = value.get("pages").and_then(Value::as_u64);
        let has_unsaved_changes = value
            .get("hasUnsavedChanges")
            .and_then(Value::as_bool)
            .unwrap_or(dirty || revision.unwrap_or(0) > 0);
        Some(Self {
            session_id,
            source_path,
            opened_at,
            last_modified,
            revision,
            dirty,
            pages,
            has_unsaved_changes,
        })
    }

    pub fn display_name(&self) -> String {
        if let Some(path) = &self.source_path
            && let Some(name) = Path::new(path).file_name().and_then(|n| n.to_str())
            && !name.is_empty()
        {
            return name.to_string();
        }
        i18n::t("recovery.untitled")
    }

    pub fn to_debug_json(&self) -> Value {
        serde_json::json!({
            "sessionId": self.session_id,
            "sourcePath": self.source_path,
            "openedAt": self.opened_at,
            "lastModified": self.last_modified,
            "revision": self.revision,
            "dirty": self.dirty,
            "pages": self.pages,
            "hasUnsavedChanges": self.has_unsaved_changes,
        })
    }
}

/// Kiểm tra nhanh trên đĩa xem có thư mục phiên chưa đóng (`closed != true`) hay không.
/// Khớp điều kiện của `core/chef_core/session/recovery.py` mà không cần khởi động `chef-core` (R3.03).
pub fn has_unclosed_sessions(user_data_dir: &Path) -> bool {
    let sessions_dir = user_data_dir.join("sessions");
    let Ok(entries) = fs::read_dir(sessions_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !is_valid_session_id(name_str) {
            continue;
        }
        let meta_path = entry.path().join("meta.json");
        let Ok(raw) = fs::read_to_string(meta_path) else {
            continue;
        };
        let Ok(Value::Object(meta)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let closed = match meta.get("closed") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        };
        if !closed {
            return true;
        }
    }
    false
}

fn is_valid_session_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Đối tượng đang chờ người dùng xác nhận xóa trong `RecoveryModal`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfirmDiscard {
    Single(String),
    All,
}

impl ConfirmDiscard {
    pub fn as_debug_str(&self) -> &str {
        match self {
            ConfirmDiscard::Single(id) => id.as_str(),
            ConfirmDiscard::All => "all",
        }
    }
}

/// Hộp thoại khôi phục phiên sau khi crash (`id = "recovery-dialog"`).
pub struct RecoveryModal {
    pub open: bool,
    pub busy: bool,
    pub sessions: Vec<RecoverableSession>,
    pub confirming_discard: Option<ConfirmDiscard>,
    pub error: Option<String>,
    later_focus: FocusHandle,
    discard_all_focus: FocusHandle,
    confirm_discard_focus: FocusHandle,
    cancel_discard_focus: FocusHandle,
}

impl RecoveryModal {
    pub fn new(cx: &mut App) -> Self {
        Self {
            open: false,
            busy: false,
            sessions: Vec::new(),
            confirming_discard: None,
            error: None,
            later_focus: cx.focus_handle(),
            discard_all_focus: cx.focus_handle(),
            confirm_discard_focus: cx.focus_handle(),
            cancel_discard_focus: cx.focus_handle(),
        }
    }

    pub fn open_with(&mut self, sessions: Vec<RecoverableSession>) {
        self.sessions = sessions;
        self.confirming_discard = None;
        self.busy = false;
        self.error = None;
        self.open = !self.sessions.is_empty();
    }

    pub fn close(&mut self) {
        self.open = false;
        self.busy = false;
        self.confirming_discard = None;
        self.error = None;
    }

    pub fn remove_session(&mut self, session_id: &str) {
        self.sessions.retain(|s| s.session_id != session_id);
        self.confirming_discard = None;
        self.busy = false;
        if self.sessions.is_empty() {
            self.close();
        }
    }

    pub fn to_debug_json(&self) -> Value {
        serde_json::json!({
            "open": self.open,
            "busy": self.busy,
            "confirmingDiscard": self.confirming_discard.as_ref().map(ConfirmDiscard::as_debug_str),
            "error": self.error,
            "sessions": self.sessions.iter().map(RecoverableSession::to_debug_json).collect::<Vec<_>>(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_dialog<V: 'static>(
        &self,
        is_dark: bool,
        window: &mut Window,
        cx: &mut Context<V>,
        entity: &Entity<V>,
        on_restore: impl Fn(&mut V, String, &mut Window, &mut Context<V>) + Copy + 'static,
        on_request_discard: impl Fn(&mut V, ConfirmDiscard, &mut Window, &mut Context<V>)
        + Copy
        + 'static,
        on_confirm_discard: impl Fn(&mut V, &mut Window, &mut Context<V>) + Copy + 'static,
        on_cancel_discard: impl Fn(&mut V, &mut Window, &mut Context<V>) + Copy + 'static,
        on_later: impl Fn(&mut V, &mut Window, &mut Context<V>) + Copy + 'static,
    ) -> Dialog {
        let text_primary = if is_dark {
            pack(dark::C_TEXT)
        } else {
            pack(light::C_TEXT)
        };
        let text_secondary = if is_dark {
            pack(dark::C_TEXT_2)
        } else {
            pack(light::C_TEXT_2)
        };
        let text_muted = if is_dark {
            pack(dark::C_TEXT_3)
        } else {
            pack(light::C_TEXT_3)
        };
        let border_col = if is_dark {
            pack(dark::C_BORDER)
        } else {
            pack(light::C_BORDER)
        };
        let sunken_bg = if is_dark {
            pack(dark::C_SURFACE_SUNKEN)
        } else {
            pack(light::C_SURFACE_SUNKEN)
        };
        let danger_col = if is_dark {
            pack(dark::C_DANGER)
        } else {
            pack(light::C_DANGER)
        };

        let mut rows = Vec::with_capacity(self.sessions.len());
        for (idx, session) in self.sessions.iter().enumerate() {
            let restore_id = format!("recovery-restore-{idx}");
            let discard_id = format!("recovery-discard-{idx}");
            let restore_focus = window
                .use_keyed_state(
                    ElementId::Name(format!("{restore_id}-focus").into()),
                    cx,
                    |_, cx| cx.focus_handle(),
                )
                .read(cx)
                .clone();
            let discard_focus = window
                .use_keyed_state(
                    ElementId::Name(format!("{discard_id}-focus").into()),
                    cx,
                    |_, cx| cx.focus_handle(),
                )
                .read(cx)
                .clone();

            let sid_restore = session.session_id.clone();
            let host_restore = entity.clone();
            let restore_btn = Button::new(restore_id, restore_focus)
                .size(Size::Sm)
                .variant(Variant::Primary)
                .label(i18n::t("recovery.restore"))
                .disabled(self.busy)
                .dark(is_dark)
                .on_click(move |_, window, cx| {
                    let sid = sid_restore.clone();
                    host_restore.update(cx, |this, cx| on_restore(this, sid, window, cx));
                });

            let sid_discard = session.session_id.clone();
            let host_discard = entity.clone();
            let discard_btn = Button::new(discard_id, discard_focus)
                .size(Size::Sm)
                .variant(Variant::Secondary)
                .label(i18n::t("recovery.discard"))
                .disabled(self.busy)
                .dark(is_dark)
                .on_click(move |_, window, cx| {
                    let target = ConfirmDiscard::Single(sid_discard.clone());
                    host_discard
                        .update(cx, |this, cx| on_request_discard(this, target, window, cx));
                });

            let pages_count = session.pages.unwrap_or(0);
            let pages_str = pages_count.to_string();
            let pages_label = i18n::tn(
                "recovery.pages",
                pages_count as i64,
                &[("count", &pages_str)],
            );
            let state_label = if session.has_unsaved_changes || session.dirty {
                i18n::t("recovery.unsaved")
            } else {
                i18n::t("recovery.clean")
            };
            let meta_line = format!("{pages_label} · {state_label}");

            let row = div()
                .id(ElementId::Name(format!("recovery-row-{idx}").into()))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(shared::SPACE_4))
                .p(px(shared::SPACE_4))
                .rounded(px(shared::RADIUS_MD))
                .bg(rgba(sunken_bg))
                .border_1()
                .border_color(rgba(border_col))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(shared::SPACE_1))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_size(px(shared::TEXT_SM))
                                .text_color(rgba(text_primary))
                                .truncate()
                                .child(SharedString::from(session.display_name())),
                        )
                        .child(
                            div()
                                .text_size(px(shared::TEXT_XS))
                                .text_color(rgba(text_muted))
                                .truncate()
                                .child(SharedString::from(meta_line)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(shared::SPACE_2))
                        .child(discard_btn)
                        .child(restore_btn),
                );
            rows.push(row.into_any_element());
        }

        let mut body = div()
            .id("recovery-dialog-body")
            .flex()
            .flex_col()
            .gap(px(shared::SPACE_4))
            .child(
                div()
                    .text_size(px(shared::TEXT_SM))
                    .text_color(rgba(text_secondary))
                    .child(i18n::t("recovery.description")),
            )
            .child(
                div()
                    .id("recovery-sessions-list")
                    .max_h(px(260.0))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(shared::SPACE_3))
                    .children(rows),
            );

        if let Some(err) = &self.error {
            body = body.child(
                div()
                    .text_size(px(shared::TEXT_XS))
                    .text_color(rgba(danger_col))
                    .child(SharedString::from(err.clone())),
            );
        }

        let footer = if let Some(confirm) = &self.confirming_discard {
            let confirm_label = match confirm {
                ConfirmDiscard::Single(_) => i18n::t("recovery.discard"),
                ConfirmDiscard::All => i18n::t("recovery.discardAll"),
            };
            let host_cancel = entity.clone();
            let cancel_btn =
                Button::new("recovery-cancel-discard", self.cancel_discard_focus.clone())
                    .label(i18n::t("common.cancel"))
                    .variant(Variant::Secondary)
                    .disabled(self.busy)
                    .dark(is_dark)
                    .on_click(move |_, window, cx| {
                        host_cancel.update(cx, |this, cx| on_cancel_discard(this, window, cx));
                    });

            let host_confirm = entity.clone();
            let confirm_btn = Button::new(
                "recovery-confirm-discard",
                self.confirm_discard_focus.clone(),
            )
            .label(confirm_label)
            .variant(Variant::Danger)
            .disabled(self.busy)
            .dark(is_dark)
            .on_click(move |_, window, cx| {
                host_confirm.update(cx, |this, cx| on_confirm_discard(this, window, cx));
            });

            vec![
                cancel_btn.into_any_element(),
                confirm_btn.into_any_element(),
            ]
        } else {
            let host_discard_all = entity.clone();
            let discard_all_btn =
                Button::new("recovery-discard-all", self.discard_all_focus.clone())
                    .label(i18n::t("recovery.discardAll"))
                    .variant(Variant::Danger)
                    .disabled(self.busy || self.sessions.is_empty())
                    .dark(is_dark)
                    .on_click(move |_, window, cx| {
                        host_discard_all.update(cx, |this, cx| {
                            on_request_discard(this, ConfirmDiscard::All, window, cx)
                        });
                    });

            let host_later = entity.clone();
            let later_btn = Button::new("recovery-later", self.later_focus.clone())
                .label(i18n::t("recovery.later"))
                .variant(Variant::Secondary)
                .disabled(self.busy)
                .dark(is_dark)
                .on_click(move |_, window, cx| {
                    host_later.update(cx, |this, cx| on_later(this, window, cx));
                });

            vec![
                discard_all_btn.into_any_element(),
                later_btn.into_any_element(),
            ]
        };

        let host_esc = entity.clone();
        let confirming = self.confirming_discard.is_some();
        let mut dialog = Dialog::new(
            "recovery-dialog",
            i18n::t("recovery.title"),
            Width::Md,
            is_dark,
        )
        .child(body)
        .on_dismiss(move |window, cx| {
            host_esc.update(cx, |this, cx| {
                if confirming {
                    on_cancel_discard(this, window, cx);
                } else {
                    on_later(this, window, cx);
                }
            });
        });
        for action in footer {
            dialog = dialog.action(action);
        }
        dialog
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "chef-recovery-test-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn has_unclosed_sessions_returns_false_when_missing_or_empty() {
        let tmp = TempDir::new("empty");
        assert!(!has_unclosed_sessions(&tmp.0));
        fs::create_dir_all(tmp.0.join("sessions")).unwrap();
        assert!(!has_unclosed_sessions(&tmp.0));
    }

    #[test]
    fn has_unclosed_sessions_ignores_invalid_names_and_closed_sessions() {
        let tmp = TempDir::new("closed");
        let sessions = tmp.0.join("sessions");
        let bad_name = sessions.join("not-a-valid-32-hex-session-id");
        fs::create_dir_all(&bad_name).unwrap();
        fs::write(bad_name.join("meta.json"), r#"{"closed": false}"#).unwrap();

        let upper_hex = sessions.join("0123456789ABCDEF0123456789ABCDEF");
        fs::create_dir_all(&upper_hex).unwrap();
        fs::write(upper_hex.join("meta.json"), r#"{"closed": false}"#).unwrap();

        let closed_valid = sessions.join("0123456789abcdef0123456789abcdef");
        fs::create_dir_all(&closed_valid).unwrap();
        fs::write(closed_valid.join("meta.json"), r#"{"closed": true}"#).unwrap();

        assert!(!has_unclosed_sessions(&tmp.0));
    }

    #[test]
    fn has_unclosed_sessions_detects_open_session() {
        let tmp = TempDir::new("open");
        let open_dir = tmp
            .0
            .join("sessions")
            .join("abcdef0123456789abcdef0123456789");
        fs::create_dir_all(&open_dir).unwrap();
        fs::write(
            open_dir.join("meta.json"),
            r#"{"sessionId": "abcdef0123456789abcdef0123456789", "closed": false}"#,
        )
        .unwrap();

        assert!(has_unclosed_sessions(&tmp.0));
    }
}
