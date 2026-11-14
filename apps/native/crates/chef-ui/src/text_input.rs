//! Ô nhập một dòng cho GPUI (TASKS_RUST R1.22). Port từ examples/input.rs của gpui (cùng tag),
//! logic văn bản nằm trong `TextBuffer` để kiểm thử được riêng.
//!
//! IME (bộ gõ Telex, Unikey, EVKey) đi qua `EntityInputHandler` và `ElementInputHandler`.
//! Đường nhận composition trên Windows là IMM32 (xem BLUEPRINT_RUST §13.1).

use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, KeyBinding,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    Render, ShapedLine, SharedString, Style, TextRun, UTF16Selection, UnderlineStyle, Window,
    actions, div, fill, point, prelude::*, px, relative, size,
};

use crate::text_buffer::{TextBuffer, single_line};

actions!(
    text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        Submit,
        SubmitBack,
        Cancel
    ]
);

/// Sự kiện của ô nhập để phần khác của app phản ứng: nội dung đổi, Enter, Shift+Enter, Esc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextInputEvent {
    Changed,
    Submit,
    SubmitBack,
    Cancel,
}

impl EventEmitter<TextInputEvent> for TextInput {}

/// Gắn phím tắt cho ô nhập. Gọi một lần khi khởi động app.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextInput")),
        KeyBinding::new("delete", Delete, Some("TextInput")),
        KeyBinding::new("left", Left, Some("TextInput")),
        KeyBinding::new("right", Right, Some("TextInput")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextInput")),
        KeyBinding::new("shift-right", SelectRight, Some("TextInput")),
        KeyBinding::new("home", Home, Some("TextInput")),
        KeyBinding::new("end", End, Some("TextInput")),
        KeyBinding::new("ctrl-a", SelectAll, Some("TextInput")),
        KeyBinding::new("ctrl-v", Paste, Some("TextInput")),
        KeyBinding::new("ctrl-c", Copy, Some("TextInput")),
        KeyBinding::new("ctrl-x", Cut, Some("TextInput")),
        KeyBinding::new("enter", Submit, Some("TextInput")),
        KeyBinding::new("shift-enter", SubmitBack, Some("TextInput")),
        KeyBinding::new("escape", Cancel, Some("TextInput")),
    ]);
}

pub struct TextInput {
    focus_handle: FocusHandle,
    buffer: TextBuffer,
    placeholder: SharedString,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    secure: bool,
}

impl TextInput {
    pub fn new(cx: &mut Context<Self>, placeholder: impl Into<SharedString>) -> Self {
        TextInput {
            focus_handle: cx.focus_handle(),
            buffer: TextBuffer::new(""),
            placeholder: placeholder.into(),
            last_layout: None,
            last_bounds: None,
            is_selecting: false,
            secure: false,
        }
    }

    /// Nội dung hiện tại (để phần khác của app đọc, ví dụ ô tìm kiếm).
    pub fn text(&self) -> &str {
        self.buffer.content()
    }

    /// Đặt nội dung từ bên ngoài (ví dụ xóa khi bấm Esc). Không phát sự kiện Changed.
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.buffer.zeroize_content();
        self.buffer = TextBuffer::new(text);
        cx.notify();
    }

    /// Mask rendered text, disable copy/cut, and zeroize the current buffer on clear/drop.
    pub fn set_secure(&mut self, secure: bool, cx: &mut Context<Self>) {
        self.secure = secure;
        cx.notify();
    }

    pub fn is_secure(&self) -> bool {
        self.secure
    }

    pub fn clear_sensitive(&mut self, cx: &mut Context<Self>) {
        self.buffer.zeroize_content();
        cx.notify();
    }

    /// Vùng chọn tính bằng byte UTF-8 (con trỏ là vùng rỗng). Dùng cho kênh debug và kiểm thử.
    pub fn selected_range(&self) -> Range<usize> {
        self.buffer.selected_range()
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.buffer.move_to(offset);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.buffer.select_to(offset);
        cx.notify();
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        let range = self.buffer.selected_range();
        if range.is_empty() {
            self.move_to(self.buffer.previous_boundary(self.buffer.cursor()), cx);
        } else {
            self.move_to(range.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        let range = self.buffer.selected_range();
        if range.is_empty() {
            self.move_to(self.buffer.next_boundary(range.end), cx);
        } else {
            self.move_to(range.end, cx);
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.buffer.previous_boundary(self.buffer.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.buffer.next_boundary(self.buffer.cursor()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.buffer.select_all();
        cx.notify();
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.buffer.content().len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.buffer.backspace() {
            cx.emit(TextInputEvent::Changed);
        } else {
            window.play_system_bell();
        }
        cx.notify();
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.buffer.delete() {
            cx.emit(TextInputEvent::Changed);
        } else {
            window.play_system_bell();
        }
        cx.notify();
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextInputEvent::Submit);
    }

    fn submit_back(&mut self, _: &SubmitBack, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextInputEvent::SubmitBack);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextInputEvent::Cancel);
        // Để Cancel đi tiếp lên khung hộp thoại (dialog.rs), khung đó cũng đóng khi Esc ở ô nhập.
        cx.propagate();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            // Ô một dòng: mỗi đoạn xuống dòng thành một khoảng trắng.
            self.replace_text_in_range(None, &single_line(&text), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if self.secure {
            return;
        }
        if !self.buffer.selected_range().is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.buffer.selected_text().to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if self.secure {
            return;
        }
        if !self.buffer.selected_range().is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.buffer.selected_text().to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.is_selecting = true;
        let offset = self.index_for_mouse_position(event.position);
        if event.modifiers.shift {
            self.select_to(offset, cx);
        } else {
            self.move_to(offset, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _cx: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting {
            let offset = self.index_for_mouse_position(event.position);
            self.select_to(offset, cx);
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.buffer.content().is_empty() {
            return 0;
        }
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.buffer.content().len();
        }
        line.closest_index_for_x(position.x - bounds.left())
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.buffer.range_from_utf16(&range_utf16);
        actual_range.replace(self.buffer.range_to_utf16(&range));
        Some(self.buffer.content()[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.buffer.range_to_utf16(&self.buffer.selected_range()),
            reversed: self.buffer.selection_reversed(),
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.buffer
            .marked_range()
            .map(|range| self.buffer.range_to_utf16(&range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.buffer.unmark();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16.map(|r| self.buffer.range_from_utf16(&r));
        self.buffer.replace_text(range, new_text);
        cx.emit(TextInputEvent::Changed);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16.map(|r| self.buffer.range_from_utf16(&r));
        // Vùng chọn mới của bộ gõ tính bằng UTF-16 tương đối với chữ vừa gửi.
        let new_selected = new_selected_range_utf16.map(|sel| {
            let start = self.utf16_relative_to_text(new_text, sel.start);
            let end = self.utf16_relative_to_text(new_text, sel.end);
            start..end
        });
        self.buffer.replace_and_mark(range, new_text, new_selected);
        cx.emit(TextInputEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let last_layout = self.last_layout.as_ref()?;
        let range = self.buffer.range_from_utf16(&range_utf16);
        Some(Bounds::from_corners(
            point(
                bounds.left() + last_layout.x_for_index(range.start),
                bounds.top(),
            ),
            point(
                bounds.left() + last_layout.x_for_index(range.end),
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let line_point = self.last_bounds?.localize(&point)?;
        let last_layout = self.last_layout.as_ref()?;
        let utf8_index = last_layout.index_for_x(point.x - line_point.x)?;
        Some(self.buffer.offset_to_utf16(utf8_index))
    }
}

impl TextInput {
    /// Đổi một vị trí UTF-16 tương đối với đầu `text` sang byte UTF-8 tương đối cùng vị trí.
    fn utf16_relative_to_text(&self, text: &str, utf16: usize) -> usize {
        let mut units = 0;
        for (byte, ch) in text.char_indices() {
            if units + ch.len_utf16() > utf16 {
                return byte;
            }
            units += ch.len_utf16();
        }
        text.len()
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// Phần vẽ: chữ, con trỏ, vùng chọn và gạch chân chữ gõ dở.
struct TextElement {
    input: Entity<TextInput>,
}

struct Prepaint {
    line: Option<ShapedLine>,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = SharedString::from(if input.secure {
            mask_preserving_offsets(input.buffer.content())
        } else {
            input.buffer.content().to_string()
        });
        let selected = input.buffer.selected_range();
        let cursor = input.buffer.cursor();
        let marked = input.buffer.marked_range();
        let style = window.text_style();

        let (display, color) = if content.is_empty() {
            (input.placeholder.clone(), style.color.opacity(0.5))
        } else {
            (content, style.color)
        };

        let run = TextRun {
            len: display.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match marked {
            Some(marked) => vec![
                TextRun {
                    len: marked.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked.end - marked.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display.len() - marked.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect(),
            None => vec![run],
        };

        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(display, font_size, &runs, None);
        let cursor_x = line.x_for_index(cursor);

        let (selection, cursor) = if selected.is_empty() {
            (
                None,
                Some(fill(
                    Bounds::new(
                        point(bounds.left() + cursor_x, bounds.top()),
                        size(px(2.), bounds.size.height),
                    ),
                    gpui::blue(),
                )),
            )
        } else {
            (
                Some(fill(
                    Bounds::from_corners(
                        point(
                            bounds.left() + line.x_for_index(selected.start),
                            bounds.top(),
                        ),
                        point(
                            bounds.left() + line.x_for_index(selected.end),
                            bounds.bottom(),
                        ),
                    ),
                    gpui::rgba(0x3311ff30),
                )),
                None,
            )
        };
        Prepaint {
            line: Some(line),
            cursor,
            selection,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        if let Some(selection) = prepaint.selection.take() {
            window.paint_quad(selection);
        }
        let line = prepaint.line.take().expect("prepaint luôn tạo dòng chữ");
        line.paint(
            bounds.origin,
            window.line_height(),
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        )
        .expect("vẽ dòng chữ thất bại");
        if focus_handle.is_focused(window)
            && let Some(cursor) = prepaint.cursor.take()
        {
            window.paint_quad(cursor);
        }
        self.input.update(cx, |input, _| {
            input.last_layout = Some(line);
            input.last_bounds = Some(bounds);
        });
    }
}

fn mask_preserving_offsets(text: &str) -> String {
    // Keep the byte length stable so GPUI cursor/selection offsets remain aligned with TextBuffer.
    "*".repeat(text.len())
}

impl Drop for TextInput {
    fn drop(&mut self) {
        self.buffer.zeroize_content();
    }
}

impl Render for TextInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .key_context("TextInput")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::submit_back))
            .on_action(cx.listener(Self::cancel))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .h(px(28.))
            .w_full()
            .px(px(8.))
            .items_center()
            .child(TextElement { input: cx.entity() })
    }
}

#[cfg(test)]
mod secure_tests {
    use super::mask_preserving_offsets;

    #[test]
    fn password_mask_does_not_change_utf8_offsets_or_reveal_text() {
        let secret = "aé🧪";
        let masked = mask_preserving_offsets(secret);
        assert_eq!(masked.len(), secret.len());
        assert_eq!(masked, "*******");
        assert!(!masked.contains('é'));
        assert!(!masked.contains('🧪'));
    }
}
