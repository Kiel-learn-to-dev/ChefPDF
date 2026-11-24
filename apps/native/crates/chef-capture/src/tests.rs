use super::*;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::AtomicU64;

fn iface(name: &str, addr: &str, v4: bool, internal: bool) -> NetIface {
    NetIface {
        name: name.into(),
        address: addr.into(),
        is_ipv4: v4,
        internal,
    }
}

#[test]
fn private_lan_addresses() {
    for ok in ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.20"] {
        assert!(is_private_lan_ipv4(ok), "{ok}");
    }
    for bad in [
        "8.8.8.8",
        "172.15.0.1",
        "172.32.0.1",
        "192.169.0.1",
        "169.254.1.1",
        "127.0.0.1",
        "10.0.0",
        "10.0.0.256",
        "a.b.c.d",
        "",
        "10.0.0.1.1",
    ] {
        assert!(!is_private_lan_ipv4(bad), "{bad}");
    }
}

#[test]
fn lan_interfaces_exclude_loopback_ipv6_and_public() {
    let list = [
        iface("lo", "127.0.0.1", true, true),
        iface("eth0", "192.168.1.5", true, false),
        iface("eth0", "fe80::1", false, false),
        iface("wan", "8.8.8.8", true, false),
        iface("wifi", "10.1.2.3", true, false),
        iface("fake-loop", "192.168.9.9", true, true),
    ];
    let lan = lan_interfaces(&list);
    assert_eq!(
        lan.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        ["eth0", "wifi"]
    );
    assert_eq!(
        choose_lan_interface(&list, None).unwrap().address,
        "192.168.1.5"
    );
    assert_eq!(
        choose_lan_interface(&list, Some("wifi")).unwrap().address,
        "10.1.2.3"
    );
    assert_eq!(
        choose_lan_interface(&list, Some("zzz")),
        Err(CaptureError::InterfaceNotFound)
    );
    assert_eq!(
        choose_lan_interface(&[iface("lo", "127.0.0.1", true, true)], None),
        Err(CaptureError::NoLanInterface)
    );
}

#[test]
fn tokens_are_random_hex_and_compared_exactly() {
    let a = new_token();
    let b = new_token();
    assert_eq!(a.len(), 32);
    assert!(
        a.bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_ne!(a, b);
    assert!(token_matches(&a, &a));
    assert!(!token_matches(&a, &b));
    assert!(!token_matches(&a[..31], &a));
    assert!(!token_matches("", &a));
}

#[test]
fn image_kinds() {
    assert_eq!(
        extension_for_content_type(Some("image/jpeg; charset=x")),
        Some(ImageExt::Jpg)
    );
    assert_eq!(
        extension_for_content_type(Some(" IMAGE/PNG ")),
        Some(ImageExt::Png)
    );
    assert_eq!(
        extension_for_content_type(Some("image/webp")),
        Some(ImageExt::Webp)
    );
    assert_eq!(extension_for_content_type(Some("image/heic")), None);
    assert_eq!(extension_for_content_type(None), None);
    assert_eq!(sniff_image(&JPEG), Some(ImageExt::Jpg));
    assert_eq!(sniff_image(&PNG), Some(ImageExt::Png));
    assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageExt::Webp));
    assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVEfmt "), None);
    assert_eq!(sniff_image(b"GIF89a"), None);
    assert_eq!(sniff_image(&[]), None);
}

#[test]
fn start_options_validation() {
    let o = parse_start_options("book", None, None).unwrap();
    assert_eq!((o.purpose, o.max_pages), (Purpose::Book, 200));
    assert_eq!(
        parse_start_options("signature", Some(500), Some("wifi"))
            .unwrap()
            .max_pages,
        500
    );
    for bad in [0, 501, -1] {
        assert!(
            matches!(
                parse_start_options("book", Some(bad), None),
                Err(CaptureError::InvalidRequest(_))
            ),
            "{bad}"
        );
    }
    assert!(parse_start_options("other", None, None).is_err());
    assert!(parse_start_options("book", None, Some(&"x".repeat(129))).is_err());
}

#[test]
fn routes_need_a_well_formed_token_and_no_query() {
    let t = "0123456789abcdef0123456789abcdef";
    assert_eq!(parse_route(&format!("/c/{t}")), Some(('c', t)));
    assert_eq!(parse_route(&format!("/u/{t}")), Some(('u', t)));
    assert_eq!(parse_route(&format!("/d/{t}")), Some(('d', t)));
    for bad in [
        format!("/x/{t}"),
        format!("/c/{t}?a=1"),
        format!("/c/{}", &t[..31]),
        format!("/c/{}", t.to_uppercase()),
        "/".into(),
        "/c/".into(),
        format!("c/{t}"),
    ] {
        assert_eq!(parse_route(&bad), None, "{bad}");
    }
}

#[test]
fn qr_svg_carries_the_text_as_escaped_title() {
    let svg = qr_svg_for("http://192.168.1.5:5000/c/abc?x=<&>").unwrap();
    assert!(svg.starts_with("<svg"));
    assert!(svg.contains("<title>http://192.168.1.5:5000/c/abc?x=&#60;&#38;&#62;</title>"));
    assert!(svg.contains("</svg>"));
}

#[test]
fn files_are_named_by_the_server() {
    assert_eq!(image_file_name(0, ImageExt::Jpg), "001.jpg");
    assert_eq!(image_file_name(41, ImageExt::Webp), "042.webp");
}

// ---------- Máy chủ thật trên loopback ----------

const JPEG: [u8; 6] = [0xff, 0xd8, 0xff, 0xe0, 0, 1];
const PNG: [u8; 12] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

struct Reply {
    status: u16,
    headers: String,
    body: String,
}

fn request(addr: &str, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut s = TcpStream::connect(addr).expect("kết nối");
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).to_string();
    let (h, b) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = h
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    Reply {
        status,
        headers: h.to_lowercase(),
        body: b.to_string(),
    }
}

struct Rig {
    svc: CaptureService,
    root: PathBuf,
    events: Arc<Mutex<Vec<Event>>>,
    clock: Arc<AtomicU64>,
}

fn rig(tag: &str, max_body: u64) -> Rig {
    let root = std::env::temp_dir().join(format!("chef-capture-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let c2 = clock.clone();
    let deps = CaptureDeps {
        interfaces: Box::new(|| vec![iface("eth0", "192.168.1.5", true, false)]),
        bind_host: Some("127.0.0.1".into()),
        capture_root: root.clone(),
        page_html: "<html>trang điện thoại</html>".into(),
        new_session_id: Box::new(|| "sess1".into()),
        now: Arc::new(move || c2.load(Ordering::SeqCst)),
        emit: Arc::new(move |e| ev.lock().unwrap().push(e)),
        max_body_bytes: max_body,
    };
    Rig {
        svc: CaptureService::new(deps),
        root,
        events,
        clock,
    }
}

fn start(r: &Rig, max_pages: i64) -> (StartResult, String, String) {
    let res = r
        .svc
        .start(&parse_start_options("book", Some(max_pages), None).unwrap())
        .unwrap();
    let rest = res.url.strip_prefix("http://").unwrap();
    let (addr, path) = rest.split_once('/').unwrap();
    let token = path.rsplit('/').next().unwrap().to_string();
    (res.clone(), addr.to_string(), token)
}

fn upload(addr: &str, token: &str, idx: &str, ct: &str, body: &[u8]) -> Reply {
    request(
        addr,
        "POST",
        &format!("/u/{token}"),
        &[("Content-Type", ct), ("X-Chef-Index", idx)],
        body,
    )
}

#[test]
fn page_is_served_with_csp_and_no_store_only_for_the_right_token() {
    let r = rig("page", 1 << 20);
    let (res, addr, token) = start(&r, 5);
    assert!(res.url.starts_with("http://127.0.0.1:"));
    assert!(res.qr_svg.contains(&res.url));
    assert_eq!(
        res.interfaces,
        vec![LanInterface {
            name: "eth0".into(),
            address: "192.168.1.5".into()
        }]
    );
    let ok = request(&addr, "GET", &format!("/c/{token}"), &[], b"");
    assert_eq!(ok.status, 200);
    assert!(ok.body.contains("trang điện thoại"));
    assert!(
        ok.headers
            .contains("content-security-policy: default-src 'none'")
    );
    assert!(ok.headers.contains("cache-control: no-store"));
    assert!(
        !ok.headers.contains("access-control-allow-origin"),
        "không CORS"
    );
    let wrong = request(&addr, "GET", &format!("/c/{}", "0".repeat(32)), &[], b"");
    assert_eq!((wrong.status, wrong.body.as_str()), (404, "Not found"));
    assert_eq!(
        request(&addr, "POST", &format!("/c/{token}"), &[], b"").status,
        404,
        "sai phương thức"
    );
    assert_eq!(
        request(&addr, "GET", &format!("/u/{token}"), &[], b"").status,
        404
    );
    assert_eq!(request(&addr, "GET", "/", &[], b"").status, 404);
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn uploads_are_stored_in_order_deduped_and_announced() {
    let r = rig("upload", 1 << 20);
    let (_, addr, token) = start(&r, 5);
    let a = upload(&addr, &token, "0", "image/jpeg", &JPEG);
    assert_eq!((a.status, a.body.as_str()), (200, "{\"index\":0}"));
    let b = upload(&addr, &token, "1", "image/png", &PNG);
    assert_eq!(b.body, "{\"index\":1}");
    // Gửi lại cùng chỉ số khách: trả đúng kết quả cũ, không ghi lần hai.
    let again = upload(&addr, &token, "0", "image/jpeg", &JPEG);
    assert_eq!((again.status, again.body.as_str()), (200, "{\"index\":0}"));
    let dir = r.root.join("sess1");
    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["001.jpg", "002.png"]);
    assert_eq!(fs::read(dir.join("001.jpg")).unwrap(), JPEG);
    assert_eq!(r.svc.status().count, 2);
    assert_eq!(r.svc.received().len(), 2);
    let images: Vec<_> = r
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, Event::Image { .. }))
        .cloned()
        .collect();
    assert_eq!(images.len(), 2);
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn bad_uploads_are_refused_without_writing() {
    let r = rig("bad", 100);
    let (_, addr, token) = start(&r, 5);
    let tick = || r.clock.fetch_add(1001, Ordering::SeqCst);
    assert_eq!(
        upload(&addr, &token, "0", "image/heic", &JPEG).status,
        415,
        "loại không nhận"
    );
    assert_eq!(
        upload(&addr, &token, "0", "image/png", &JPEG).status,
        415,
        "byte đầu không khớp loại"
    );
    assert_eq!(
        upload(&addr, &token, "0", "text/plain", b"hello").status,
        415
    );
    let no_index = request(
        &addr,
        "POST",
        &format!("/u/{token}"),
        &[("Content-Type", "image/jpeg")],
        &JPEG,
    );
    assert_eq!(no_index.status, 400);
    let bad_index = upload(&addr, &token, "abc", "image/jpeg", &JPEG);
    assert_eq!(bad_index.status, 400);
    tick();
    let mut big = JPEG.to_vec();
    big.resize(300, 0);
    assert_eq!(
        upload(&addr, &token, "0", "image/jpeg", &big).status,
        413,
        "vượt giới hạn thân"
    );
    assert_eq!(r.svc.status().count, 0);
    assert_eq!(fs::read_dir(r.root.join("sess1")).unwrap().count(), 0);
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn page_limit_is_enforced() {
    let r = rig("limit", 1 << 20);
    let (_, addr, token) = start(&r, 2);
    // Giữ dưới 5 yêu cầu mỗi giây.
    assert_eq!(upload(&addr, &token, "0", "image/jpeg", &JPEG).status, 200);
    assert_eq!(upload(&addr, &token, "1", "image/jpeg", &JPEG).status, 200);
    let over = upload(&addr, &token, "2", "image/jpeg", &JPEG);
    assert_eq!(
        (over.status, over.body.as_str()),
        (409, "{\"error\":\"limit\"}")
    );
    assert_eq!(r.svc.status().count, 2);
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn more_than_five_requests_in_a_second_get_429_with_retry_after() {
    let r = rig("rate", 1 << 20);
    let (_, addr, token) = start(&r, 50);
    let mut statuses = Vec::new();
    for _ in 0..6 {
        statuses.push(request(&addr, "GET", &format!("/c/{token}"), &[], b""));
    }
    assert!(statuses[..5].iter().all(|s| s.status == 200));
    assert_eq!(statuses[5].status, 429);
    assert!(statuses[5].headers.contains("retry-after: 1"));
    // Một giây sau lại nhận được.
    r.clock.fetch_add(1001, Ordering::SeqCst);
    assert_eq!(
        request(&addr, "GET", &format!("/c/{token}"), &[], b"").status,
        200
    );
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn done_ends_the_session_and_closes_the_port() {
    let r = rig("done", 1 << 20);
    let (_, addr, token) = start(&r, 5);
    upload(&addr, &token, "0", "image/jpeg", &JPEG);
    let d = request(&addr, "POST", &format!("/d/{token}"), &[], b"");
    assert_eq!((d.status, d.body.as_str()), (200, "{\"count\":1}"));
    wait_for(|| {
        r.events.lock().unwrap().iter().any(|e| {
            matches!(
                e,
                Event::Status {
                    state: CaptureState::Done,
                    count: 1,
                    ..
                }
            )
        })
    });
    assert_eq!(r.svc.status().state, CaptureState::Done);
    wait_for(|| TcpStream::connect(&addr).is_err());
    assert!(
        fs::read(r.root.join("sess1/001.jpg")).is_ok(),
        "file ở lại cho người gọi"
    );
    let _ = fs::remove_dir_all(&r.root);
}

fn wait_for(cond: impl Fn() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("điều kiện không đạt trong 4 giây");
}

#[test]
fn stop_closes_the_server_and_goes_idle() {
    let r = rig("stop", 1 << 20);
    let (res, addr, token) = start(&r, 5);
    assert_eq!(r.svc.status().state, CaptureState::Active);
    r.svc.stop(Some("khác"));
    assert_eq!(
        r.svc.status().state,
        CaptureState::Active,
        "sai mã phiên thì không dừng"
    );
    r.svc.stop(Some(&res.session_id));
    assert_eq!(r.svc.status().state, CaptureState::Idle);
    wait_for(|| TcpStream::connect(&addr).is_err());
    let _ = token;
    assert!(r.events.lock().unwrap().iter().any(|e| matches!(
        e,
        Event::Status {
            state: CaptureState::Stopped,
            ..
        }
    )));
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn session_expires_after_ten_minutes() {
    let r = rig("expire", 1 << 20);
    let (res, addr, _) = start(&r, 5);
    assert_eq!(res.expires_at, 1_000_000 + CAPTURE_TIMEOUT_MS);
    r.clock.store(res.expires_at, Ordering::SeqCst);
    wait_for(|| {
        r.events.lock().unwrap().iter().any(|e| {
            matches!(
                e,
                Event::Status {
                    state: CaptureState::Expired,
                    ..
                }
            )
        })
    });
    wait_for(|| TcpStream::connect(&addr).is_err());
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn a_new_start_stops_the_previous_session_and_stale_folders_are_swept_once() {
    let r = rig("restart", 1 << 20);
    fs::create_dir_all(r.root.join("old-session")).unwrap();
    fs::write(r.root.join("old-session/001.jpg"), JPEG).unwrap();
    let (_, addr1, _) = start(&r, 5);
    assert!(
        !r.root.join("old-session").exists(),
        "thư mục phiên cũ bị dọn"
    );
    let (_, addr2, _) = start(&r, 5);
    assert_ne!(addr1, addr2);
    wait_for(|| TcpStream::connect(&addr1).is_err());
    r.svc.stop(None);
    let _ = fs::remove_dir_all(&r.root);
}

#[test]
fn no_lan_interface_is_an_error_and_nothing_listens() {
    let root = std::env::temp_dir().join(format!("chef-capture-nolan-{}", std::process::id()));
    let deps = CaptureDeps {
        interfaces: Box::new(|| vec![iface("lo", "127.0.0.1", true, true)]),
        bind_host: None,
        capture_root: root.clone(),
        page_html: String::new(),
        new_session_id: Box::new(|| "s".into()),
        now: Arc::new(|| 0),
        emit: Arc::new(|_| {}),
        max_body_bytes: 10,
    };
    let svc = CaptureService::new(deps);
    let o = parse_start_options("book", None, None).unwrap();
    assert_eq!(svc.start(&o).unwrap_err(), CaptureError::NoLanInterface);
    assert_eq!(svc.status().state, CaptureState::Idle);
    assert!(!root.exists(), "không tạo thư mục khi lỗi");
}

#[test]
fn the_token_never_appears_in_events() {
    let r = rig("notoken", 1 << 20);
    let (_, addr, token) = start(&r, 5);
    upload(&addr, &token, "0", "image/jpeg", &JPEG);
    r.svc.stop(None);
    let all = format!("{:?}", r.events.lock().unwrap());
    assert!(!all.contains(&token));
    let _ = fs::remove_dir_all(&r.root);
}
