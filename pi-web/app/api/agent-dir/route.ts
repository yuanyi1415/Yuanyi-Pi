import { getAgentDir } from "@earendil-works/pi-coding-agent";

export async function GET() {
  return Response.json({ agentDir: getAgentDir() });
}
