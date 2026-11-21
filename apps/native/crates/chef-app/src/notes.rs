//! Models and wire helpers for R4.18 sticky notes and free text annotations.

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub id: String,
    pub page_index: usize,
    pub subtype: String,
    pub contents: String,
    pub author: String,
    pub replies: Vec<String>,
    pub in_reply_to: Option<String>,
    pub status: Option<String>,
    pub rect: [f32; 4],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormMode {
    AddNote,
    AddFreeText,
    Edit(String),
    Reply(String),
}

pub fn notes_from_reply(reply: &Value) -> Result<Vec<Note>, String> {
    let items = reply
        .get("data")
        .and_then(|data| data.get("annots"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Core returned an invalid annotation list".to_string())?;
    items
        .iter()
        .filter(|item| {
            matches!(
                item.get("subtype").and_then(Value::as_str),
                Some("Text" | "FreeText")
            )
        })
        .map(|item| {
            let rect = item
                .get("rect")
                .and_then(Value::as_array)
                .filter(|rect| rect.len() == 4)
                .and_then(|rect| rect.iter().map(Value::as_f64).collect::<Option<Vec<_>>>())
                .ok_or_else(|| "Core returned invalid annotation geometry".to_string())?;
            Ok(Note {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Core returned an annotation without an ID".to_string())?
                    .to_owned(),
                page_index: item
                    .get("pageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|page| usize::try_from(page).ok())
                    .ok_or_else(|| "Core returned an invalid annotation page".to_string())?,
                subtype: item["subtype"].as_str().unwrap_or_default().to_owned(),
                contents: item
                    .get("contents")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                author: item
                    .get("author")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                replies: item
                    .get("replies")
                    .and_then(Value::as_array)
                    .map(|replies| {
                        replies
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                in_reply_to: item
                    .get("inReplyTo")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                rect: [
                    rect[0] as f32,
                    rect[1] as f32,
                    rect[2] as f32,
                    rect[3] as f32,
                ],
            })
        })
        .collect()
}

pub fn add_note_params(
    page_index: usize,
    left: f32,
    top: f32,
    contents: &str,
    author: &str,
) -> Result<Value, String> {
    validate_contents(contents)?;
    if !left.is_finite() || !top.is_finite() || left < 0.0 || top < 0.0 {
        return Err("The note position is invalid".into());
    }
    Ok(
        json!({"pageIndex":page_index,"left":left,"top":top,"contents":contents.trim(),"author":author.trim()}),
    )
}

pub fn update_note_params(id: &str, contents: &str, author: &str) -> Result<Value, String> {
    validate_id(id)?;
    validate_contents(contents)?;
    Ok(json!({"id":id,"contents":contents.trim(),"author":author.trim()}))
}

pub fn reply_params(id: &str, text: &str, author: &str) -> Result<Value, String> {
    validate_id(id)?;
    validate_contents(text)?;
    Ok(json!({"id":id,"text":text.trim(),"author":author.trim()}))
}

pub fn completed_params(id: &str) -> Result<Value, String> {
    validate_id(id)?;
    Ok(json!({"id":id,"status":"completed"}))
}

pub fn free_text_params(
    page_index: usize,
    rect: [f32; 4],
    text: &str,
    author: &str,
) -> Result<Value, String> {
    validate_contents(text)?;
    if rect.iter().any(|v| !v.is_finite())
        || rect[0] < 0.0
        || rect[1] < 0.0
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err("The text box geometry is invalid".into());
    }
    Ok(json!({"pageIndex":page_index,"rect":rect,"text":text.trim(),"author":author.trim()}))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        Err("The annotation ID is invalid".into())
    } else {
        Ok(())
    }
}

fn validate_contents(contents: &str) -> Result<(), String> {
    if contents.trim().is_empty() {
        Err("Annotation text cannot be empty".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_note_threads_and_ignores_other_annotation_types() {
        let reply = json!({"data":{"annots":[
            {"id":"A0:new:1","pageIndex":0,"subtype":"Text","rect":[1,2,21,22],"contents":"Root","author":"A","replies":["A0:new:2"],"status":"completed"},
            {"id":"A0:new:2","pageIndex":0,"subtype":"Text","rect":[1,2,21,22],"contents":"Child","author":"B","inReplyTo":"A0:new:1"},
            {"id":"A0:new:3","pageIndex":0,"subtype":"Highlight","rect":[1,2,21,22]}
        ]}});
        let notes = notes_from_reply(&reply).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].replies, ["A0:new:2"]);
        assert_eq!(notes[0].status.as_deref(), Some("completed"));
        assert_eq!(notes[1].in_reply_to.as_deref(), Some("A0:new:1"));
    }

    #[test]
    fn builds_note_edit_reply_status_and_free_text_params() {
        assert_eq!(
            add_note_params(2, 30.0, 40.0, " Note ", " A ").unwrap()["contents"],
            "Note"
        );
        assert_eq!(
            update_note_params("A0:current:0", "Edit", "B").unwrap()["id"],
            "A0:current:0"
        );
        assert_eq!(
            reply_params("A0:current:0", "Reply", "B").unwrap()["text"],
            "Reply"
        );
        assert_eq!(
            completed_params("A0:current:0").unwrap()["status"],
            "completed"
        );
        assert_eq!(
            free_text_params(0, [1.0, 2.0, 20.0, 30.0], "Text", "A").unwrap()["rect"],
            json!([1.0, 2.0, 20.0, 30.0])
        );
        assert!(reply_params("", "Reply", "B").is_err());
        assert!(add_note_params(0, 0.0, 0.0, " ", "").is_err());
        assert!(free_text_params(0, [2.0, 2.0, 1.0, 4.0], "Text", "").is_err());
    }
}
