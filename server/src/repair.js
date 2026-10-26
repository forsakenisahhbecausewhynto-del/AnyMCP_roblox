import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HttpError } from "./security.js";

const MAX_PATCH_BYTES = 50_000;

export async function prepareRepairProposal({ directory, summary, patch }) {
  if (typeof summary !== "string" || summary.length === 0 || summary.length > 1_000) {
    throw new HttpError(400, "invalid_repair", "Repair summary is invalid.");
  }
  if (typeof patch !== "string" || patch.length === 0 || Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    throw new HttpError(400, "invalid_repair", "Repair patch is invalid.");
  }
  if (/\b(eval|Function|child_process|execSync|spawnSync)\b/.test(patch)) {
    throw new HttpError(400, "prohibited_repair", "Repair patch contains a prohibited operation.");
  }

  const id = `${Date.now()}-${randomUUID()}`;
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.patch`);
  await writeFile(file, `# PENDING APPROVAL\n# ${summary}\n${patch}`, {
    encoding: "utf8",
    flag: "wx"
  });
  return { id, file, status: "pending_approval" };
}

export function requireApprovedProposal(proposal) {
  if (!proposal || proposal.status !== "approved") {
    throw new Error("Repair proposal requires explicit maintainer approval.");
  }
  return proposal;
}
