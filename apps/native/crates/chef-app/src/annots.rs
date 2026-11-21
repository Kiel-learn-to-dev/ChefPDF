use chef_pdf::text::{CharBox, Rect};
use serde_json::{Value, json};
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkupKind {
    Highlight,
    Underline,
    Strike,
}

impl MarkupKind {
    fn as_core_value(self) -> &'static str {
        match self {
            Self::Highlight => "highlight",
            Self::Underline => "underline",
            Self::Strike => "strike",
        }
    }

    pub fn as_core_subtype(self) -> &'static str {
        match self {
            Self::Highlight => "Highlight",
            Self::Underline => "Underline",
            Self::Strike => "StrikeOut",
        }
    }
}

/// Produce one point-space rectangle per selected text line, preserving page rotation.
pub fn selected_rects(chars: &[CharBox], range: Range<usize>) -> Result<Vec<Rect>, String> {
    if range.start > range.end || range.end > chars.len() {
        return Err("The selected text range is invalid".into());
    }
    if range.is_empty() {
        return Err("Select text before adding markup".into());
    }
    let rects = chef_pdf::search::rects(chars, range);
    if rects.is_empty() {
        return Err("The selected text has no visible glyphs".into());
    }
    Ok(rects)
}

pub fn selected_rects_across_pages(
    pages: &[(usize, &[CharBox])],
    first: (usize, usize),
    last: (usize, usize),
) -> Result<Vec<(usize, Vec<Rect>)>, String> {
    if first.0 > last.0
        || pages.is_empty()
        || pages.first().map(|(page, _)| *page) != Some(first.0)
        || pages.last().map(|(page, _)| *page) != Some(last.0)
        || last
            .0
            .checked_sub(first.0)
            .and_then(|count| count.checked_add(1))
            != Some(pages.len())
        || pages
            .iter()
            .enumerate()
            .any(|(offset, (page, _))| first.0.checked_add(offset) != Some(*page))
        || first.1 > pages[0].1.len()
    {
        return Err("The selected text range is invalid".into());
    }
    let mut selected = Vec::new();
    for (page_index, chars) in pages {
        if *page_index < first.0 || *page_index > last.0 {
            continue;
        }
        let start = if *page_index == first.0 { first.1 } else { 0 };
        let end = if *page_index == last.0 {
            last.1
                .checked_add(1)
                .ok_or("The selected text range is invalid")?
        } else {
            chars.len()
        };
        if start > end || end > chars.len() {
            return Err("The selected text range is invalid".into());
        }
        let rects = if pages.len() == 1 {
            selected_rects(chars, start..end)?
        } else {
            chef_pdf::search::rects(chars, start..end)
        };
        if !rects.is_empty() {
            selected.push((*page_index, rects));
        }
    }
    if selected.is_empty() {
        return Err("The selected text has no visible glyphs".into());
    }
    Ok(selected)
}

/// Build `annots.addTextMarkup` parameters from point-space boxes and an RGBA GPUI color.
pub fn add_text_markup_params(
    page_index: usize,
    kind: MarkupKind,
    rects: &[Rect],
    color_rgba: u32,
) -> Result<Value, String> {
    if rects.is_empty()
        || rects.iter().any(|rect| {
            !rect.left.is_finite()
                || !rect.top.is_finite()
                || !rect.right.is_finite()
                || !rect.bottom.is_finite()
                || rect.right <= rect.left
                || rect.bottom <= rect.top
        })
    {
        return Err("The selected text geometry is invalid".into());
    }
    let rgb = color_rgba >> 8;
    let opacity = (color_rgba & 0xff) as f32 / 255.0;
    let color = format!("#{rgb:06X}");
    let boxes: Vec<[f32; 4]> = rects
        .iter()
        .map(|rect| [rect.left, rect.top, rect.right, rect.bottom])
        .collect();
    Ok(json!({
        "pageIndex": page_index,
        "kind": kind.as_core_value(),
        "rects": boxes,
        "color": color,
        "opacity": opacity,
    }))
}

pub fn add_text_markup_pages_params(
    kind: MarkupKind,
    pages: &[(usize, Vec<Rect>)],
    color_rgba: u32,
) -> Result<Value, String> {
    if pages.is_empty() {
        return Err("Select text before adding markup".into());
    }
    let mut page_params = Vec::with_capacity(pages.len());
    for (page_index, rects) in pages {
        let single = add_text_markup_params(*page_index, kind, rects, color_rgba)?;
        page_params.push(json!({
            "pageIndex": page_index,
            "rects": single["rects"],
        }));
    }
    let rgb = color_rgba >> 8;
    let opacity = (color_rgba & 0xff) as f32 / 255.0;
    Ok(json!({
        "kind": kind.as_core_value(),
        "pages": page_params,
        "color": format!("#{rgb:06X}"),
        "opacity": opacity,
    }))
}

/// Find the current core ID for a markup whose page, subtype, and line quads match the selection.
/// IDs are revision-specific, so callers must pass a fresh `annots.list` reply.
pub fn matching_markup_ids(
    reply: &Value,
    page_index: usize,
    kind: MarkupKind,
    selected: &[Rect],
) -> Option<Vec<String>> {
    if selected.is_empty() {
        return None;
    }
    let items = reply.get("data")?.get("annots")?.as_array()?;
    let mut matched = vec![false; selected.len()];
    let mut ids = Vec::with_capacity(selected.len());
    for item in items.iter().rev() {
        if item.get("pageIndex")?.as_u64()? as usize != page_index
            || item.get("subtype")?.as_str()? != kind.as_core_subtype()
        {
            continue;
        }
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(quads) = item.get("quads").and_then(Value::as_array) else {
            continue;
        };
        let mut item_matched = false;
        for quad in quads {
            let Some(rect) = quad_bounds(quad) else {
                continue;
            };
            if let Some(index) = selected
                .iter()
                .enumerate()
                .position(|(index, expected)| !matched[index] && rect_near(rect, *expected))
            {
                matched[index] = true;
                item_matched = true;
            }
        }
        if item_matched {
            ids.push(id.to_owned());
        }
        if matched.iter().all(|found| *found) {
            return Some(ids);
        }
    }
    None
}

pub fn update_markup_color_params(ids: &[String], color_rgba: u32) -> Result<Value, String> {
    if ids.is_empty() || ids.iter().any(String::is_empty) {
        return Err("The selected markup ID is invalid".into());
    }
    let rgb = color_rgba >> 8;
    Ok(json!({ "ids": ids, "color": format!("#{rgb:06X}") }))
}

fn quad_bounds(value: &Value) -> Option<Rect> {
    let coords = value.as_array()?;
    if coords.len() != 8 {
        return None;
    }
    let points = coords
        .iter()
        .map(Value::as_f64)
        .collect::<Option<Vec<_>>>()?;
    let (mut left, mut top, mut right, mut bottom) = (
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    );
    for pair in points.chunks_exact(2) {
        let (x, y) = (pair[0] as f32, pair[1] as f32);
        left = left.min(x);
        right = right.max(x);
        top = top.min(y);
        bottom = bottom.max(y);
    }
    Some(Rect {
        left,
        top,
        right,
        bottom,
    })
}

fn rect_near(a: Rect, b: Rect) -> bool {
    const TOLERANCE: f32 = 1.0;
    (a.left - b.left).abs() <= TOLERANCE
        && (a.top - b.top).abs() <= TOLERANCE
        && (a.right - b.right).abs() <= TOLERANCE
        && (a.bottom - b.bottom).abs() <= TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(ch: char, rect: Rect, line: Rect) -> CharBox {
        CharBox { ch, rect, line }
    }

    #[test]
    fn selected_rects_merge_glyphs_by_line_and_skip_whitespace() {
        let line_one = Rect {
            left: 0.0,
            top: 0.0,
            right: 30.0,
            bottom: 12.0,
        };
        let line_two = Rect {
            left: 0.0,
            top: 20.0,
            right: 30.0,
            bottom: 32.0,
        };
        let chars = vec![
            glyph(
                'A',
                Rect {
                    left: 1.0,
                    top: 2.0,
                    right: 5.0,
                    bottom: 9.0,
                },
                line_one,
            ),
            glyph(
                ' ',
                Rect {
                    left: 5.0,
                    top: 2.0,
                    right: 8.0,
                    bottom: 9.0,
                },
                line_one,
            ),
            glyph(
                'B',
                Rect {
                    left: 9.0,
                    top: 1.0,
                    right: 14.0,
                    bottom: 10.0,
                },
                line_one,
            ),
            glyph(
                'C',
                Rect {
                    left: 2.0,
                    top: 22.0,
                    right: 7.0,
                    bottom: 30.0,
                },
                line_two,
            ),
        ];

        let rects = selected_rects(&chars, 0..chars.len()).unwrap();
        assert_eq!(
            rects,
            vec![
                Rect {
                    left: 1.0,
                    top: 1.0,
                    right: 14.0,
                    bottom: 10.0
                },
                Rect {
                    left: 2.0,
                    top: 22.0,
                    right: 7.0,
                    bottom: 30.0
                },
            ]
        );
    }

    #[test]
    fn selected_rects_reject_invalid_or_empty_ranges() {
        let chars = vec![glyph(
            ' ',
            Rect {
                left: 0.0,
                top: 0.0,
                right: 1.0,
                bottom: 1.0,
            },
            Rect {
                left: 0.0,
                top: 0.0,
                right: 1.0,
                bottom: 1.0,
            },
        )];
        assert!(selected_rects(&chars, 2..3).is_err());
        assert!(selected_rects(&chars, Range { start: 1, end: 0 }).is_err());
        assert!(selected_rects(&chars, 0..1).is_err());
    }

    #[test]
    fn selected_rects_can_cross_page_boundaries() {
        let line = Rect {
            left: 0.0,
            top: 0.0,
            right: 30.0,
            bottom: 10.0,
        };
        let chars = vec![
            glyph(
                'a',
                Rect {
                    right: 10.0,
                    ..line
                },
                line,
            ),
            glyph(
                'b',
                Rect {
                    left: 10.0,
                    right: 20.0,
                    ..line
                },
                line,
            ),
            glyph('c', Rect { left: 20.0, ..line }, line),
        ];
        let pages = vec![(2, chars.as_slice()), (3, chars.as_slice())];
        let selected = selected_rects_across_pages(&pages, (2, 1), (3, 0)).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].0, 2);
        assert_eq!(selected[0].1[0].left, 10.0);
        assert_eq!(selected[1].0, 3);
        assert_eq!(selected[1].1[0].right, 10.0);
        assert!(selected_rects_across_pages(&pages, (2, 0), (4, 1)).is_err());
    }

    #[test]
    fn params_keep_point_geometry_markup_kind_and_theme_alpha() {
        let rects = [Rect {
            left: 1.0,
            top: 2.0,
            right: 11.0,
            bottom: 12.0,
        }];
        let params =
            add_text_markup_params(3, MarkupKind::Underline, &rects, 0x12_34_56_80).unwrap();
        assert_eq!(params["pageIndex"], 3);
        assert_eq!(params["kind"], "underline");
        assert_eq!(params["rects"][0], json!([1.0, 2.0, 11.0, 12.0]));
        assert_eq!(params["color"], "#123456");
        assert!((params["opacity"].as_f64().unwrap() - 128.0 / 255.0).abs() < 0.0001);
        for (kind, expected) in [
            (MarkupKind::Highlight, "highlight"),
            (MarkupKind::Underline, "underline"),
            (MarkupKind::Strike, "strike"),
        ] {
            let params = add_text_markup_params(0, kind, &rects, 0xFFFF00FF).unwrap();
            assert_eq!(params["kind"], expected);
        }
    }

    #[test]
    fn params_group_selected_rects_by_page_for_one_atomic_operation() {
        let pages = vec![
            (
                1,
                vec![Rect {
                    left: 2.0,
                    top: 3.0,
                    right: 12.0,
                    bottom: 13.0,
                }],
            ),
            (
                4,
                vec![Rect {
                    left: 20.0,
                    top: 30.0,
                    right: 40.0,
                    bottom: 50.0,
                }],
            ),
        ];
        let params =
            add_text_markup_pages_params(MarkupKind::Highlight, &pages, 0xFFFF00FF).unwrap();
        assert_eq!(params["pages"][0]["pageIndex"], 1);
        assert_eq!(
            params["pages"][0]["rects"][0],
            json!([2.0, 3.0, 12.0, 13.0])
        );
        assert_eq!(params["pages"][1]["pageIndex"], 4);
        assert_eq!(
            params["pages"][1]["rects"][0],
            json!([20.0, 30.0, 40.0, 50.0])
        );
        assert_eq!(params["kind"], "highlight");
    }

    #[test]
    fn params_reject_invalid_rectangles() {
        let rects = [Rect {
            left: 0.0,
            top: 0.0,
            right: f32::NAN,
            bottom: 4.0,
        }];
        assert!(add_text_markup_params(0, MarkupKind::Highlight, &rects, 0xFFFF00FF).is_err());
    }

    #[test]
    fn update_color_params_use_the_current_annotation_id_and_rgba_color() {
        let params = update_markup_color_params(&["A3:012345abcdef:0".into()], 0xFF8A0080).unwrap();
        assert_eq!(params["ids"], json!(["A3:012345abcdef:0"]));
        assert_eq!(params["color"], "#FF8A00");
        assert!(params.get("opacity").is_none());
        assert!(update_markup_color_params(&[], 0xFF8A00FF).is_err());
    }

    #[test]
    fn matches_current_markup_by_page_type_and_selected_geometry() {
        let selected = [Rect {
            left: 10.0,
            top: 20.0,
            right: 30.0,
            bottom: 34.0,
        }];
        let reply = json!({"data":{"annots":[
            {"id":"A0:old:0","pageIndex":1,"subtype":"Highlight","quads":[[10.1,20.1,30.1,20.1,10.1,34.1,30.1,34.1]]},
            {"id":"A1:current:0","pageIndex":0,"subtype":"Highlight","quads":[[10.1,20.1,30.1,20.1,10.1,34.1,30.1,34.1]]},
            {"id":"A1:other:0","pageIndex":0,"subtype":"Underline","quads":[[10.1,20.1,30.1,20.1,10.1,34.1,30.1,34.1]]}
        ]}});
        assert_eq!(
            matching_markup_ids(&reply, 0, MarkupKind::Highlight, &selected).as_deref(),
            Some(&["A1:current:0".to_owned()][..])
        );
        assert_eq!(
            matching_markup_ids(&reply, 0, MarkupKind::Strike, &selected),
            None
        );
    }

    #[test]
    fn matches_per_line_markup_annotations_as_one_selection() {
        let selected = [
            Rect {
                left: 0.0,
                top: 0.0,
                right: 20.0,
                bottom: 10.0,
            },
            Rect {
                left: 0.0,
                top: 20.0,
                right: 30.0,
                bottom: 30.0,
            },
        ];
        let reply = json!({"data":{"annots":[
            {"id":"A0:current:1","pageIndex":0,"subtype":"Highlight","quads":[[0,20,30,20,0,30,30,30]]},
            {"id":"A0:current:0","pageIndex":0,"subtype":"Highlight","quads":[[0,0,20,0,0,10,20,10]]}
        ]}});
        let ids = matching_markup_ids(&reply, 0, MarkupKind::Highlight, &selected).unwrap();
        assert_eq!(ids, ["A0:current:0", "A0:current:1"]);
    }

    #[test]
    fn matches_all_selected_quads_in_one_existing_annotation_once() {
        let selected = [
            Rect {
                left: 0.0,
                top: 0.0,
                right: 20.0,
                bottom: 10.0,
            },
            Rect {
                left: 0.0,
                top: 20.0,
                right: 30.0,
                bottom: 30.0,
            },
        ];
        let reply = json!({"data":{"annots":[
            {"id":"A0:multi:0","pageIndex":0,"subtype":"Highlight","quads":[
                [0,20,30,20,0,30,30,30], [0,0,20,0,0,10,20,10]
            ]}
        ]}});
        assert_eq!(
            matching_markup_ids(&reply, 0, MarkupKind::Highlight, &selected),
            Some(vec!["A0:multi:0".to_owned()])
        );
    }
}
