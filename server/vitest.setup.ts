// 测试隔离：所有测试共享同一个临时数据目录，
// 避免 runner 测试的 resetDb() 误删 server/data 下的开发数据。
import path from "node:path";
import os from "node:os";

process.env.INFRAPILOT_DATA_DIR = path.join(os.tmpdir(), "infrapilot-test-data");
