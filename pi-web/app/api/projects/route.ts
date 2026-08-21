import { NextResponse } from "next/server";
import { gatewayEnabled, gatewayListProjects, gatewayRemoveProject, gatewayRenameProject, legacyRuntimeEnabled, runtimeUnavailableResponse } from "@/lib/personal-gateway";
import { getRecentProjects } from "@/lib/project-groups";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (gatewayEnabled()) return NextResponse.json(await gatewayListProjects(), { headers: { "Cache-Control": "no-store" } });
    if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
    const sessions = await listAllSessions({ force: false });
    return NextResponse.json({
      projects: getRecentProjects(sessions).map((project) => ({
        path: project.root,
        displayName: project.displayName,
        createdAt: 0,
        updatedAt: Date.now(),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!gatewayEnabled()) return legacyRuntimeEnabled() ? NextResponse.json({ error: "Project registry requires Personal Gateway" }, { status: 501 }) : runtimeUnavailableResponse();
  try {
    const body = await req.json() as { projectDirectory?: string; displayName?: string };
    if (!body.projectDirectory || !body.displayName?.trim()) return NextResponse.json({ error: "projectDirectory and displayName are required" }, { status: 400 });
    return NextResponse.json(await gatewayRenameProject(body.projectDirectory, body.displayName.trim()));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!gatewayEnabled()) return legacyRuntimeEnabled() ? NextResponse.json({ error: "Project registry requires Personal Gateway" }, { status: 501 }) : runtimeUnavailableResponse();
  try {
    const body = await req.json() as { projectDirectory?: string };
    if (!body.projectDirectory) return NextResponse.json({ error: "projectDirectory is required" }, { status: 400 });
    return NextResponse.json(await gatewayRemoveProject(body.projectDirectory));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
