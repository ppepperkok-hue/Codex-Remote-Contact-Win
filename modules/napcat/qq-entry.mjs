import { app } from "electron";

// Per-account QQ data dir override: set NAPCAT_QQ_DATA_DIR before launching.
if (process.env.NAPCAT_QQ_DATA_DIR) {
  try {
    app.setPath("userData", process.env.NAPCAT_QQ_DATA_DIR);
  } catch (err) {
    console.error("[qq-entry] setPath(userData) failed:", err);
  }
}

await import(new URL("./napcat/napcat.mjs", import.meta.url).href);
