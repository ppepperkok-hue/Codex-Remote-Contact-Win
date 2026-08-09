// Wake-on-LAN sender for the Windows port.
// Reads MAC/broadcast config from data/wake.json (gitignored); sends magic
// packets over UDP so the app / dashboard can wake the machine from sleep.
import dgram from "node:dgram";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./settings.js";

const DEFAULT_CONFIG = { macs: [], broadcast: "255.255.255.255", port: 9 };

function loadConfig() {
  const path = join(projectDir, "data", "wake.json");
  try {
    if (existsSync(path)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
    }
  } catch (error) {
    console.error(`Failed to load ${path}:`, error.message);
  }
  return DEFAULT_CONFIG;
}

function buildPacket(mac) {
  const hex = String(mac || "").replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) return null;
  const bytes = Buffer.from(hex, "hex");
  const packet = Buffer.alloc(102);
  for (let i = 0; i < 6; i++) packet[i] = 0xff;
  for (let i = 6; i < 102; i++) packet[i] = bytes[i % 6];
  return packet;
}

export function getWakeInfo() {
  const config = loadConfig();
  return { macs: config.macs, broadcast: config.broadcast, port: config.port };
}

export function sendWake() {
  const config = loadConfig();
  if (!config.macs.length) {
    return Promise.resolve({ ok: false, error: "no MAC configured (edit data/wake.json)" });
  }
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const sent = [];
    const errors = [];
    let pending = config.macs.length;
    const finish = () => {
      if (--pending <= 0) {
        socket.close();
        resolve({ ok: errors.length === 0, sent, errors });
      }
    };
    for (const mac of config.macs) {
      const packet = buildPacket(mac);
      if (!packet) {
        errors.push(`${mac}: invalid MAC`);
        finish();
        continue;
      }
      socket.send(packet, 0, packet.length, config.port, config.broadcast, (error) => {
        if (error) errors.push(`${mac}: ${error.message}`);
        else sent.push(mac);
        finish();
      });
    }
  });
}
