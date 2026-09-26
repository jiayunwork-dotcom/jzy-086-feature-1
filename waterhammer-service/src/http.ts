import Fastify, { type FastifyInstance } from "fastify";
import { ServiceError } from "./errors.js";
import { validateRequest } from "./validation.js";
import { runSimulation } from "./solver.js";
import { summarize } from "./analysis.js";

/**
 * HTTP 层：只做 JSON 进、JSON 出，无任何前端页面。
 *
 *   GET  /health    -> { status: "ok" }
 *   POST /simulate  -> 阀门水头序列 + 摘要 + 全管末态
 *   错误             -> 400 { error: { code, message, details? } }
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(400).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }
    // JSON 解析失败等 Fastify 自身 400
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.status(status).send({
      error: {
        code: status === 400 ? "INVALID_INPUT" : "INTERNAL",
        message: err.message,
        details: null,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/simulate", async (req, reply) => {
    const input = validateRequest(req.body);
    const result = runSimulation(input);
    const summary = summarize(result);
    const singleSegment = result.grid.pipes.length === 1;
    const pipeGrids = result.grid.pipes.map((p) => ({
      index: p.index,
      segments: p.segments,
      dx: p.dx,
      length: p.length,
      diameter: p.diameter,
      waveSpeed: p.waveSpeed,
      frictionFactor: p.frictionFactor,
      travelTime: p.travelTime,
    }));
    const grid = singleSegment
      ? // 单段：与旧响应逐字段一致（segments/dx/dt/steps/courant）
        {
          segments: result.grid.segments,
          dx: result.grid.dx,
          dt: result.grid.dt,
          steps: result.grid.steps,
          courant: 1,
        }
      : // 多段：公共时步 + 总长/总分段 + 逐段网格
        {
          totalSegments: result.grid.totalSegments,
          totalLength: result.grid.totalLength,
          dt: result.grid.dt,
          steps: result.grid.steps,
          courant: 1,
          pipes: pipeGrids,
        };
    return reply.send({
      grid,
      valve: result.valve,
      // 各内部连接点的水头时间序列（单段时为空数组）
      junctions: result.junctions.map((j) => ({
        index: j.index,
        x: j.x,
        time: j.time,
        head: j.head,
      })),
      summary,
      finalState: result.finalState,
    });
  });

  return app;
}
