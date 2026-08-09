// CLI wrapper around the Computer Use bridge, callable by the agent.
// Usage:
//   node tools/computer-use-cli.mjs list-apps
//   node tools/computer-use-cli.mjs list-windows
//   node tools/computer-use-cli.mjs launch <app-id>
//   node tools/computer-use-cli.mjs state <app> <window-id> [includeText=true]
//   node tools/computer-use-cli.mjs describe <app> <window-id> [prompt...]
//   node tools/computer-use-cli.mjs activate <app> <window-id>
//   node tools/computer-use-cli.mjs click <app> <window-id> <x> <y>
//   node tools/computer-use-cli.mjs click-index <app> <window-id> <index>
//   node tools/computer-use-cli.mjs type <app> <window-id> <text>
//   node tools/computer-use-cli.mjs key <app> <window-id> <key>
import {
  cuActivateWindow,
  cuClick,
  cuDescribe,
  cuGetWindowState,
  cuLaunchApp,
  cuListApps,
  cuListWindows,
  cuPressKey,
  cuTypeText
} from "../src/computer-use.js";

const [action, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  switch (action) {
    case "list-apps": {
      const r = await cuListApps();
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "list-windows": {
      const r = await cuListWindows();
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "launch": {
      if (!rest[0]) fail("launch requires <app-id>");
      const r = await cuLaunchApp(rest[0]);
      console.log(JSON.stringify(r));
      break;
    }
    case "state": {
      if (!rest[0] || !rest[1]) fail("state requires <app> <window-id>");
      const r = await cuGetWindowState({ app: rest[0], id: Number(rest[1]), includeText: rest[2] !== "false" });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "describe": {
      if (!rest[0] || !rest[1]) fail("describe requires <app> <window-id>");
      const r = await cuDescribe({ app: rest[0], id: Number(rest[1]), prompt: rest.slice(2).join(" ") });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "activate": {
      if (!rest[0] || !rest[1]) fail("activate requires <app> <window-id>");
      const r = await cuActivateWindow({ app: rest[0], id: Number(rest[1]) });
      console.log(JSON.stringify(r));
      break;
    }
    case "click": {
      if (!rest[0] || !rest[1] || rest[2] == null || rest[3] == null) {
        fail("click requires <app> <window-id> <x> <y>");
      }
      const r = await cuClick({ app: rest[0], id: Number(rest[1]), x: Number(rest[2]), y: Number(rest[3]) });
      console.log(JSON.stringify(r));
      break;
    }
    case "click-index": {
      if (!rest[0] || !rest[1] || rest[2] == null) fail("click-index requires <app> <window-id> <index>");
      const r = await cuClick({ app: rest[0], id: Number(rest[1]), elementIndex: Number(rest[2]) });
      console.log(JSON.stringify(r));
      break;
    }
    case "type": {
      if (!rest[0] || !rest[1] || !rest[2]) fail("type requires <app> <window-id> <text>");
      const r = await cuTypeText({ app: rest[0], id: Number(rest[1]), text: rest.slice(2).join(" ") });
      console.log(JSON.stringify(r));
      break;
    }
    case "key": {
      if (!rest[0] || !rest[1] || !rest[2]) fail("key requires <app> <window-id> <key>");
      const r = await cuPressKey({ app: rest[0], id: Number(rest[1]), key: rest[2] });
      console.log(JSON.stringify(r));
      break;
    }
    default:
      fail(
        "usage: node tools/computer-use-cli.mjs <list-apps|list-windows|launch|state|describe|activate|click|click-index|type|key> ..."
      );
  }
}

main().catch((e) => fail(`ERROR: ${e.message}`));
