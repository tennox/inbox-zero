import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import { cleanThread, cleanThreadBody } from "@/app/api/clean/clean-thread";

export const POST = withError(
  withQstashOrInternal(async (request: RequestWithLogger) => {
    const json = await request.json();
    const body = cleanThreadBody.parse(json);

    await cleanThread({
      ...body,
      logger: request.logger,
    });

    return NextResponse.json({ success: true });
  }),
);
