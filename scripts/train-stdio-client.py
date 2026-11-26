#!/usr/bin/env python3
"""训练 stdio 协议的最小 Python 客户端（无模型冒烟 / 对接样例）。

它只演示协议：spawn `scripts/train-stdio.mjs`，读 hello，reset 一局，然后
按候选 key 或引擎脚本策略逐步推进。接真实模型时，把 `choose_action` 换成
你的策略即可，不需要改引擎侧。

示例：
    python scripts/train-stdio-client.py --scenario=1 --seed=20261126 --max-steps=200
    python scripts/train-stdio-client.py --scenario=Intro --policy=scripted --max-steps=80
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "scripts" / "train-stdio.mjs"


class ProtocolError(RuntimeError):
    pass


class StdioClient:
    def __init__(self, argv: list[str]) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("PATH 里找不到 node")
        self.proc = subprocess.Popen(
            [node, str(SERVER), *argv],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.next_id = 1
        self.hello = self._read_until(lambda message: message.get("type") == "hello")

    def _read_message(self) -> dict[str, Any]:
        if self.proc.stdout is None:
            raise RuntimeError("服务端 stdout 已关闭")
        line = self.proc.stdout.readline()
        if line == "":
            raise RuntimeError("服务端提前退出；检查 stderr")
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            raise ProtocolError(f"服务端输出不是 JSON：{line!r}") from error
        if message.get("type") == "fatal":
            raise ProtocolError(f"服务端启动失败：{message.get('error')}")
        return message

    def _read_until(self, predicate):
        while True:
            message = self._read_message()
            if predicate(message):
                return message

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        payload = {**payload, "id": request_id}
        if self.proc.stdin is None:
            raise RuntimeError("服务端 stdin 已关闭")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        while True:
            message = self._read_message()
            if message.get("id") != request_id:
                continue
            if message.get("type") == "error":
                error = message.get("error") or {}
                raise ProtocolError(f"{error.get('code')}: {error.get('message')}")
            return message

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                try:
                    self.call({"type": "close"})
                except (ProtocolError, RuntimeError):
                    pass
        finally:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)


def choose_action(response: dict[str, Any], policy: str) -> dict[str, Any]:
    candidates = response.get("candidates") or []
    if policy == "scripted" or not candidates:
        return {"type": "step", "policy": "scripted"}
    if policy == "first":
        chosen = candidates[0]
    else:
        chosen = random.choice(candidates)
    return {"type": "step", "key": chosen["key"]}


def main() -> int:
    parser = argparse.ArgumentParser(description="OCS 训练 stdio 协议 Python 客户端")
    parser.add_argument("--scenario", default="1")
    parser.add_argument("--seed", type=int, default=20261126)
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument("--control", default="both", choices=("both", "axis", "soviet"))
    parser.add_argument("--policy", choices=("first", "random", "scripted"), default="scripted")
    parser.add_argument("--expect-version", type=int, default=3)
    parser.add_argument("--bundle", default=None)
    parser.add_argument("--no-bundle", action="store_true")
    args = parser.parse_args()

    server_args = [
        f"--scenario={args.scenario}",
        f"--seed={args.seed}",
        f"--max-steps={args.max_steps}",
        f"--control={args.control}",
    ]
    if args.bundle is not None:
        server_args.append(f"--bundle={args.bundle}")
    if args.no_bundle:
        server_args.append("--no-bundle")

    client: StdioClient | None = None
    try:
        client = StdioClient(server_args)
        version = client.hello.get("trainVersion")
        if version != args.expect_version:
            raise ProtocolError(
                f"trainVersion={version!r}，期望 {args.expect_version}；拒绝加载不匹配的数据/模型"
            )
        response = client.call(
            {
                "type": "reset",
                "scenarioId": args.scenario,
                "seed": args.seed,
                "maxSteps": args.max_steps,
            }
        )
        steps = 0
        while not response.get("done") and steps < args.max_steps:
            response = client.call(choose_action(response, args.policy))
            steps += 1
        print(
            json.dumps(
                {
                    "scenarioId": args.scenario,
                    "seed": args.seed,
                    "trainVersion": version,
                    "steps": steps,
                    "done": bool(response.get("done")),
                    "terminal": response.get("terminal"),
                    "lastActionKey": response.get("actionKey"),
                    "lastInfo": response.get("info"),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if response.get("done") else 2
    except (ProtocolError, RuntimeError, OSError) as error:
        print(f"[train-stdio-client] {error}", file=sys.stderr)
        return 1
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
