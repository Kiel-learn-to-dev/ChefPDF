"""Operation registry, ops.list, job lifecycle, cancellation and error mapping."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from conftest import Harness, RpcFailure
from pydantic import Field

from chef_core.errors import ChefError, ErrorKind
from chef_core.models import WireModel
from chef_core.ops import base
from chef_core.ops.base import OpContext, OpOutput, operation

V01_OPS = {
    "page.rotate",
    "page.delete",
    "page.duplicate",
    "page.reorder",
    "page.extract",
    "page.insertBlank",
    "page.insertFromFile",
    "page.insertImages",
    "file.merge",
    "file.split",
}


class SleepParams(WireModel):
    steps: int = Field(ge=1)
    delay: float = 0.01
    fail_with: str | None = None
    modify: bool = False


@pytest.fixture
def test_ops() -> Iterator[None]:
    """Register test-only operations for the duration of a test."""

    def body(ctx: OpContext, p: SleepParams) -> OpOutput:
        for i in range(p.steps):
            ctx.progress(i, p.steps, f"step {i}")
            time.sleep(p.delay)
        ctx.progress(p.steps, p.steps)
        if p.fail_with == "internal":
            raise RuntimeError("boom")
        if p.fail_with:
            raise ChefError(ErrorKind(p.fail_with), "requested failure")
        if p.modify:
            with ctx.open_input() as pdf:
                pdf.pages[0].rotate(90, relative=True)
                ctx.save_document(pdf)
        return OpOutput(changed_pages=[0] if p.modify else [], data={"steps": p.steps})

    operation(id="test.sleep", title="Sleep", group="test", params=SleepParams, standalone=True)(
        body
    )
    operation(id="test.sessionSleep", title="Sleep", group="test", params=SleepParams)(body)
    try:
        yield
    finally:
        base._REGISTRY.pop("test.sleep", None)
        base._REGISTRY.pop("test.sessionSleep", None)


def test_ops_list(harness: Harness) -> None:
    listed = {d["id"]: d for d in harness.call("ops.list", {})}
    assert set(listed) >= V01_OPS
    rotate = listed["page.rotate"]
    assert rotate["group"] == "page" and rotate["title"]
    assert rotate["destructive"] is True and rotate["standalone"] is False
    schema = rotate["paramsSchema"]
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"pages", "angle"}
    assert schema["properties"]["angle"]["enum"] == [90, 180, 270]
    merge = listed["file.merge"]
    assert merge["standalone"] is True and merge["destructive"] is False
    assert "outputPath" in merge["paramsSchema"]["properties"]  # camelCase on the wire
    assert listed["file.split"]["paramsSchema"]["properties"]["nameTemplate"]["default"] == (
        "{name}_{index}"
    )
    for d in listed.values():
        assert set(d) == {
            "id",
            "title",
            "group",
            "paramsSchema",
            "destructive",
            "finalizing",
            "batchable",
            "standalone",
        }


def test_duplicate_registration_rejected() -> None:
    with pytest.raises(ValueError):
        operation(id="page.rotate", title="x", group="page", params=SleepParams)(
            lambda ctx, p: OpOutput()
        )


def test_job_lifecycle(harness: Harness, test_ops: None) -> None:
    job_id = harness.start_op("test.sleep", {"steps": 3})
    final = harness.wait_job(job_id)
    assert final["method"] == "job.finished"
    result = final["params"]["result"]
    assert result == {
        "state": None,
        "changedPages": [],
        "warnings": [],
        "outputs": [],
        "data": {"steps": 3},
    }
    events = harness.notifications(job_id)
    assert events[-1] is final or events[-1] == final
    progress = [e["params"] for e in events if e["method"] == "job.progress"]
    assert progress and progress[0]["done"] == 0 and progress[-1]["done"] == 3
    assert all(p["total"] == 3 for p in progress)
    # Exactly one terminal notification.
    assert sum(e["method"] != "job.progress" for e in events) == 1


def test_response_precedes_job_notifications(harness: Harness, test_ops: None) -> None:
    req = harness.send("ops.run", {"opId": "test.sleep", "params": {"steps": 1, "delay": 0}})
    job_id = harness.response(req)["jobId"]
    harness.wait_job(job_id)
    with harness.out.cond:
        msgs = list(harness.out.messages)
    first_response = next(i for i, m in enumerate(msgs) if m.get("id") == req)
    first_event = next(
        i
        for i, m in enumerate(msgs)
        if m.get("params", {}).get("jobId") == job_id and "method" in m
    )
    assert first_response < first_event


def test_cancel_running_job(harness: Harness, test_ops: None) -> None:
    job_id = harness.start_op("test.sleep", {"steps": 500, "delay": 0.01})
    harness.out.wait_for(
        lambda m: m.get("method") == "job.progress" and m["params"]["jobId"] == job_id
    )
    assert harness.call("jobs.cancel", {"jobId": job_id}) is None
    final = harness.wait_job(job_id, timeout=10)
    assert final["method"] == "job.cancelled"
    assert final["params"] == {"jobId": job_id}
    # Cancelling again / unknown ids is a no-op.
    assert harness.call("jobs.cancel", {"jobId": job_id}) is None
    assert harness.call("jobs.cancel", {"jobId": "unknown"}) is None


def test_cancel_queued_session_job_and_no_revision(
    harness: Harness, test_ops: None, numbered: Callable[[int], Path]
) -> None:
    sid = harness.open(numbered(1))["state"]["sessionId"]
    first = harness.start_op("test.sessionSleep", {"steps": 30, "delay": 0.02}, sid)
    second = harness.start_op("test.sessionSleep", {"steps": 1, "modify": True}, sid)
    harness.call("jobs.cancel", {"jobId": second})  # still queued behind the first job
    assert harness.wait_job(first)["method"] == "job.finished"
    assert harness.wait_job(second)["method"] == "job.cancelled"
    assert harness.notifications(second) == [harness.wait_job(second)]  # never started
    assert harness.call("session.state", {"sessionId": sid})["revision"] == 0


def test_cancel_modifying_job_leaves_session_unchanged(
    harness: Harness, test_ops: None, numbered: Callable[[int], Path]
) -> None:
    sid = harness.open(numbered(1))["state"]["sessionId"]
    job = harness.start_op("test.sessionSleep", {"steps": 300, "delay": 0.01, "modify": True}, sid)
    harness.out.wait_for(
        lambda m: m.get("method") == "job.progress" and m["params"]["jobId"] == job
    )
    harness.call("jobs.cancel", {"jobId": job})
    assert harness.wait_job(job)["method"] == "job.cancelled"
    state = harness.call("session.state", {"sessionId": sid})
    assert state["revision"] == 0 and not state["canUndo"]
    leftovers = list((harness.data_dir / "sessions" / sid).glob(".pending-*"))
    assert leftovers == []


def test_session_jobs_run_serially(
    harness: Harness, test_ops: None, numbered: Callable[[int], Path]
) -> None:
    sid = harness.open(numbered(1))["state"]["sessionId"]
    jobs = [
        harness.start_op("test.sessionSleep", {"steps": 2, "modify": True}, sid) for _ in range(5)
    ]
    revisions = [harness.wait_job(j)["params"]["result"]["state"]["revision"] for j in jobs]
    assert revisions == [1, 2, 3, 4, 5]


def test_job_failures(harness: Harness, test_ops: None) -> None:
    job = harness.start_op("test.sleep", {"steps": 1, "failWith": "internal"})
    final = harness.wait_job(job)
    assert final["method"] == "job.failed"
    error = final["params"]["error"]
    assert error["code"] == -32000 and error["data"]["kind"] == "INTERNAL"

    job = harness.start_op("test.sleep", {"steps": 1, "failWith": "PASSWORD_INVALID"})
    error = harness.wait_job(job)["params"]["error"]
    assert error["data"]["kind"] == "PASSWORD_INVALID" and error["code"] == -32000

    job = harness.start_op("test.sleep", {"steps": 1, "failWith": "INVALID_PARAMS"})
    error = harness.wait_job(job)["params"]["error"]
    assert error["data"]["kind"] == "INVALID_PARAMS" and error["code"] == -32602


def test_ops_run_validation(
    harness: Harness, test_ops: None, numbered: Callable[[int], Path]
) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"opId": "nope.nothing", "params": {}})
    assert exc.value.kind == "OP_NOT_FOUND" and exc.value.code == -32000
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"opId": "test.sleep", "params": {"steps": 0}})
    assert exc.value.kind == "INVALID_PARAMS" and exc.value.code == -32602
    assert exc.value.detail["errors"][0]["loc"] == ["steps"]
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"opId": "test.sleep", "params": {"steps": 1, "bogus": 1}})
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:  # session op without session
        harness.call("ops.run", {"opId": "page.rotate", "params": {"pages": [0], "angle": 90}})
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {"sessionId": "missing", "opId": "page.rotate", "params": {"pages": [0], "angle": 90}},
        )
    assert exc.value.kind == "SESSION_NOT_FOUND"


def test_close_session_with_running_job(
    harness: Harness, test_ops: None, numbered: Callable[[int], Path]
) -> None:
    sid = harness.open(numbered(1))["state"]["sessionId"]
    job = harness.start_op("test.sessionSleep", {"steps": 1000, "delay": 0.01}, sid)
    harness.out.wait_for(
        lambda m: m.get("method") == "job.progress" and m["params"]["jobId"] == job
    )
    assert harness.call("session.close", {"sessionId": sid}) is None
    assert harness.wait_job(job, timeout=10)["method"] == "job.cancelled"
    assert not (harness.data_dir / "sessions" / sid).exists()
