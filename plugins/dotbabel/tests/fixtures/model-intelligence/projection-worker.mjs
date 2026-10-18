/** Native child-process fixture for projection lock and interruption tests. */
import fs from "node:fs";
import { materializationFixture } from "./materialize.mjs";
import { syncProjectionTree } from "../../../src/model-intelligence/materialize/transaction.mjs";

const [root, label, ready, release] = process.argv.slice(2);
try {
  const outcome = await syncProjectionTree({ root, loadInputs: () => {
    const input = materializationFixture(); input.artifacts[0].sourceContent += label + "\n";
    return input;
  }, onStep: async step => {
    if (ready && step.kind === "file") {
      fs.writeFileSync(ready, "ready"); const deadline = Date.now() + 10_000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error("fixture wait expired");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } });
  console.log(JSON.stringify(outcome));
} catch (error) {
  console.log(JSON.stringify({ status: "failed", code: error.code ?? "fixture_failed" }));
  process.exitCode = 1;
}
