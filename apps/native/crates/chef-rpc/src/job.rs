//! Job Object của Windows cho tiến trình lõi (TASKS_RUST R3.02, BLUEPRINT_RUST §7.2).
//!
//! Lõi chạy qua launcher của venv: `Scripts\python.exe` khởi động Python base như một tiến trình con.
//! Kill launcher không dừng tiến trình con, nên mọi tiến trình của lõi được gom vào một Job có
//! `KILL_ON_JOB_CLOSE`: đóng job là dừng cả cây, kể cả khi app bị kill.
//!
//! Để không có tiến trình con nào thoát khỏi job, lõi được tạo ở trạng thái `CREATE_SUSPENDED`, gán
//! vào job, rồi mới resume. Nếu gán sau khi chạy, tiến trình con có thể đã được tạo trước khi gán.

use std::io;
use std::mem::size_of;
use std::os::raw::c_void;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::addr_of;

use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread,
    THREAD_SUSPEND_RESUME,
};
use windows::core::PCWSTR;

/// Job Object giữ tiến trình lõi và các tiến trình con của nó.
pub struct JobObject {
    handle: HANDLE,
}

// SAFETY: HANDLE của job là tài nguyên của nhân Windows. Terminate, Query và Close đều dùng được từ
// nhiều luồng; không có con trỏ Rust nào được chia sẻ.
unsafe impl Send for JobObject {}
// SAFETY: như trên; mọi thao tác trên job đều qua API hệ điều hành.
unsafe impl Sync for JobObject {}

fn to_io(err: windows::core::Error) -> io::Error {
    io::Error::other(err.message())
}

impl JobObject {
    /// Tạo job mới có `KILL_ON_JOB_CLOSE`: khi handle cuối cùng đóng, mọi tiến trình trong job bị dừng.
    pub fn kill_on_close() -> io::Result<JobObject> {
        // SAFETY: gọi API Win32 với tham số hợp lệ; handle được gói vào JobObject ngay, để Drop đóng.
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null()).map_err(to_io)?;
            let job = JobObject { handle };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                addr_of!(info).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(to_io)?;
            Ok(job)
        }
    }

    /// Gán tiến trình (đang ở trạng thái suspended) vào job.
    pub fn assign(&self, child: &Child) -> io::Result<()> {
        let process = HANDLE(child.as_raw_handle() as isize);
        // SAFETY: `self.handle` là job còn mở; `process` là handle tiến trình còn sống, do `child` giữ.
        unsafe { AssignProcessToJobObject(self.handle, process).map_err(to_io) }
    }

    /// Dừng mọi tiến trình còn trong job. Job vẫn tồn tại; Drop đóng handle.
    pub fn terminate(&self) {
        // SAFETY: `self.handle` là job còn mở.
        let _ = unsafe { TerminateJobObject(self.handle, 1) };
    }

    /// PID của mọi tiến trình đang trong job (gồm tiến trình con).
    pub fn process_ids(&self) -> io::Result<Vec<u32>> {
        let mut capacity = 16usize;
        loop {
            // Mỗi PID là một usize; struct có sẵn một ô, nên `capacity + 1` ô đủ cho `capacity` PID.
            let bytes =
                size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() + capacity * size_of::<usize>();
            // Vec<usize> để căn lề đúng cho struct.
            let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let ptr = buffer.as_mut_ptr().cast::<c_void>();
            // SAFETY: buffer đủ dung lượng và căn lề đúng cho struct.
            let result = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    ptr,
                    bytes as u32,
                    None,
                )
            };
            let list = buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            // SAFETY: hai u32 đầu của struct luôn nằm trong buffer; hệ điều hành ghi chúng kể cả khi thiếu chỗ.
            let (assigned, listed) = unsafe {
                (
                    (*list).NumberOfAssignedProcesses as usize,
                    (*list).NumberOfProcessIdsInList as usize,
                )
            };
            if result.is_ok() {
                let count = listed.min(capacity + 1);
                // SAFETY: count không vượt số ô usize trong buffer, tính từ ô đầu của ProcessIdList.
                let ids = unsafe {
                    let first = addr_of!((*list).ProcessIdList).cast::<usize>();
                    std::slice::from_raw_parts(first, count)
                };
                return Ok(ids.iter().map(|&pid| pid as u32).collect());
            }
            if assigned > capacity && capacity < 4096 {
                capacity = assigned.max(capacity * 2);
                continue;
            }
            return Err(io::Error::other(
                "không đọc được danh sách tiến trình của job",
            ));
        }
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        // SAFETY: handle được tạo bởi CreateJobObjectW và chưa đóng.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

/// Resume mọi luồng của tiến trình đang suspended (lúc tạo, chỉ có luồng chính).
pub fn resume_threads(pid: u32) -> io::Result<()> {
    // SAFETY: snapshot và handle luồng được đóng ngay khi xong; struct được khởi tạo đúng dwSize.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(to_io)?;
        let result = resume_from_snapshot(snapshot, pid);
        let _ = CloseHandle(snapshot);
        result
    }
}

unsafe fn resume_from_snapshot(snapshot: HANDLE, pid: u32) -> io::Result<()> {
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: snapshot hợp lệ; entry có dwSize đúng.
    if unsafe { Thread32First(snapshot, &mut entry) }.is_err() {
        return Err(io::Error::other("không liệt kê được luồng của lõi"));
    }
    let mut resumed = 0;
    loop {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: mở luồng với quyền tối thiểu để resume; handle được đóng ngay sau đó.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                .map_err(to_io)?;
            // SAFETY: thread là handle vừa mở.
            let previous = unsafe { ResumeThread(thread) };
            let _ = unsafe { CloseHandle(thread) };
            if previous == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        // SAFETY: snapshot và entry hợp lệ.
        if unsafe { Thread32Next(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    if resumed == 0 {
        return Err(io::Error::other("không tìm thấy luồng để resume"));
    }
    Ok(())
}

/// Tiến trình có còn chạy không (kiểm tra trong kiểm thử và chẩn đoán).
pub fn process_alive(pid: u32) -> bool {
    // SAFETY: mở với quyền truy vấn tối thiểu; handle được đóng ngay.
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(process, &mut code).is_ok();
        let _ = CloseHandle(process);
        ok && code == STILL_ACTIVE.0 as u32
    }
}
