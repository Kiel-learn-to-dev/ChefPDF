//! Trạng thái chế độ sửa đối tượng (TASKS_RUST R4.11, R7.11; FEATURES D4–D7, E2): port `objectState.ts`.
//! Cờ chế độ, đối tượng đang chọn, bộ lọc xem theo loại (E2) và đối tượng của các trang đã nạp. Bộ nhớ đệm
//! trang gắn với khóa `<doc id>:<phiên bản bản sửa>`: trả lời của khóa khác (bản sửa cũ, tài liệu khác) bị bỏ,
//! nên một lần `listObjects` chậm không đưa đối tượng cũ lên màn hình. Không lưu ra đĩa. Logic thuần.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::object_model::{ObjectKind, PageObject};

#[derive(Debug, Clone, Default)]
pub struct ObjectEditState {
    /// Chế độ sửa đối tượng đang bật.
    pub active: bool,
    pub selected: Vec<String>,
    /// Đối tượng của các trang đã nạp, theo chỉ số trang.
    pub objects: HashMap<usize, Vec<PageObject>>,
    /// Loại hiển thị của bộ lọc xem theo loại; `None` khi tắt lọc.
    pub kinds: Option<Vec<ObjectKind>>,
    /// Tóm tắt xem theo loại (`ViewByTypeData` của lõi) của các trang đã nạp, chỉ khi bật lọc.
    pub types: HashMap<usize, Value>,
    /// Khóa bản sửa mà bộ nhớ đệm thuộc về.
    pub key: String,
}

fn doc_of(key: &str) -> &str {
    key.split(':').next().unwrap_or("")
}

impl ObjectEditState {
    /// Tắt chế độ thì bỏ vùng chọn.
    pub fn set_active(&mut self, active: bool) {
        self.active = active;
        if !active {
            self.selected.clear();
        }
    }

    pub fn set_selected(&mut self, ids: Vec<String>) {
        self.selected = ids;
    }

    /// Đổi bộ lọc loại: bỏ tóm tắt đã nạp (tính lại theo bộ lọc mới).
    pub fn set_kinds(&mut self, kinds: Option<Vec<ObjectKind>>) {
        self.kinds = kinds;
        self.types.clear();
    }

    /// Bắt đầu bộ nhớ đệm mới cho một bản sửa (bỏ mọi trang). Bản sửa khác của cùng tài liệu giữ vùng chọn (một lần
    /// sửa sẽ ánh xạ lại mã); tài liệu khác thì bỏ.
    pub fn reset_for(&mut self, key: &str) {
        if self.key == key {
            return;
        }
        let same_doc = doc_of(&self.key) == doc_of(key);
        self.key = key.to_string();
        self.objects.clear();
        self.types.clear();
        if !same_doc {
            self.selected.clear();
        }
    }

    /// Ghi đối tượng của một trang. Khóa khác khóa hiện tại thì bỏ.
    pub fn set_page(&mut self, key: &str, index: usize, objects: Vec<PageObject>) {
        if self.key == key {
            self.objects.insert(index, objects);
        }
    }

    pub fn set_types(&mut self, key: &str, index: usize, data: Value) {
        if self.key == key {
            self.types.insert(index, data);
        }
    }
}

/// Đối tượng của vùng chọn, tra trong các trang đã nạp (theo thứ tự trang rồi thứ tự trong trang).
pub fn selected_objects<'a>(
    objects: &'a HashMap<usize, Vec<PageObject>>,
    selected: &[String],
) -> Vec<&'a PageObject> {
    let ids: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut pages: Vec<&usize> = objects.keys().collect();
    pages.sort();
    pages
        .into_iter()
        .flat_map(|p| objects[p].iter())
        .filter(|o| ids.contains(o.id.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(id: &str, page: usize) -> PageObject {
        PageObject {
            id: id.into(),
            page_index: page,
            kind: ObjectKind::Image,
            ordinal: 0,
            parent_id: None,
            editable: true,
            bbox: [0.0, 0.0, 10.0, 10.0],
            layer: None,
            clipped: false,
            opacity: [1.0, 1.0],
            fill_color: None,
            stroke_color: None,
            string: None,
            font: None,
            font_size: None,
            pixel_size: None,
        }
    }

    #[test]
    fn page_answers_for_another_key_are_dropped() {
        let mut s = ObjectEditState::default();
        s.reset_for("d:1");
        s.set_page("d:0", 0, vec![obj("a", 0)]);
        assert!(s.objects.is_empty(), "bản sửa cũ bị bỏ");
        s.set_page("d:1", 0, vec![obj("a", 0)]);
        assert_eq!(s.objects[&0].len(), 1);
        s.set_types("e:1", 0, json!({}));
        assert!(s.types.is_empty());
        s.set_types("d:1", 0, json!({ "counts": {} }));
        assert_eq!(s.types.len(), 1);
    }

    #[test]
    fn new_revision_of_same_document_keeps_selection_other_document_drops_it() {
        let mut s = ObjectEditState::default();
        s.reset_for("d:1");
        s.set_page("d:1", 0, vec![obj("a", 0)]);
        s.set_selected(vec!["a".into()]);
        s.reset_for("d:2");
        assert_eq!(
            s.selected,
            ["a"],
            "cùng tài liệu: một lần sửa sẽ ánh xạ lại mã"
        );
        assert!(s.objects.is_empty(), "nhưng bộ nhớ đệm trang bị xóa");
        s.reset_for("d:2");
        s.set_page("d:2", 0, vec![obj("b", 0)]);
        s.reset_for("d:2");
        assert!(!s.objects.is_empty(), "cùng khóa thì giữ");
        s.reset_for("khác:1");
        assert!(s.selected.is_empty());
    }

    #[test]
    fn turning_the_mode_off_clears_the_selection() {
        let mut s = ObjectEditState::default();
        s.set_active(true);
        s.set_selected(vec!["a".into()]);
        s.set_active(false);
        assert!(!s.active && s.selected.is_empty());
    }

    #[test]
    fn changing_the_kind_filter_drops_summaries() {
        let mut s = ObjectEditState::default();
        s.reset_for("d:1");
        s.set_types("d:1", 0, json!({}));
        s.set_kinds(Some(vec![ObjectKind::Image]));
        assert!(s.types.is_empty());
        s.set_kinds(None);
        assert!(s.kinds.is_none());
    }

    #[test]
    fn selected_objects_are_looked_up_in_page_order() {
        let mut m = HashMap::new();
        m.insert(2, vec![obj("c", 2), obj("d", 2)]);
        m.insert(0, vec![obj("a", 0), obj("b", 0)]);
        let ids: Vec<_> = selected_objects(&m, &["d".into(), "a".into(), "zzz".into()])
            .iter()
            .map(|o| o.id.clone())
            .collect();
        assert_eq!(ids, ["a", "d"]);
    }
}
