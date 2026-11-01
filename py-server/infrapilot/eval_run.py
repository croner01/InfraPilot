"""评测 CLI —— `python3 -m infrapilot.eval_run [base-url]`（对应 npm run eval:agent）。

对每个 case 真实创建会话并等待结论，然后做确定性 check + LLM-as-judge，全过 exit 0。
"""

from __future__ import annotations

import asyncio
import sys

from . import db
from .eval import list_cases, run_case


async def _main(base_url: str) -> int:
    db.init_db()
    cases = [c["case"] for c in list_cases()]
    print(f"运行 {len(cases)} 个评测 case, base={base_url}")
    results: list[bool] = []
    for case in cases:
        try:
            result = await run_case(case, base_url=base_url)
        except Exception as err:  # noqa: BLE001 - 单个 case 异常不应中断整轮评测
            print(f"[ERROR] {case.get('id')}: {err}")
            results.append(False)
            continue
        print(f"[{'PASS' if result['passedAll'] else 'FAIL'}] {case.get('id')} ({result.get('status')})")
        for check in result["checks"]:
            print(f"   {'✓' if check['passed'] else '✗'} {check['check']}")
        judge = result.get("judge")
        if judge:
            print(f"   judge={judge.get('verdict')} score={judge.get('score')} ({judge.get('mode')})")
        results.append(bool(result["passedAll"]))
    passed = sum(1 for r in results if r)
    print(f"\n结果: {passed}/{len(results)} 通过")
    return 0 if passed == len(results) and results else 1


def main() -> None:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
    raise SystemExit(asyncio.run(_main(base)))


if __name__ == "__main__":
    main()
