// ============================================================================
// linux-mcp-server — gRPC 服务端认证中间件
// ============================================================================

import * as grpc from "@grpc/grpc-js";
import { verifyMcpJwt, isToolAllowed, type McpJwtPayload } from "../auth.js";

export interface AuthenticatedCall extends grpc.ServerUnaryCall<any, any> {
  auth?: McpJwtPayload;
}

type GrpcHandler<TRequest, TResponse> = (
  call: grpc.ServerUnaryCall<TRequest, TResponse>,
  callback: grpc.sendUnaryData<TResponse>
) => void;

export function createAuthMiddleware<TRequest, TResponse>(
  allowedTool: string
): (handler: GrpcHandler<TRequest, TResponse>) => GrpcHandler<TRequest, TResponse> {
  return (handler) => {
    return (call, callback) => {
      try {
        const metadata = call.metadata.get("authorization");
        if (!metadata || metadata.length === 0) {
          callback({ code: grpc.status.UNAUTHENTICATED, message: "缺少 authorization metadata" } as grpc.ServiceError);
          return;
        }

        const authHeader = String(metadata[0]);
        if (!authHeader.startsWith("Bearer ")) {
          callback({ code: grpc.status.UNAUTHENTICATED, message: "authorization 格式错误" } as grpc.ServiceError);
          return;
        }

        const token = authHeader.slice("Bearer ".length);
        const payload = verifyMcpJwt(token);

        if (!isToolAllowed(payload, allowedTool)) {
          callback({ code: grpc.status.PERMISSION_DENIED, message: `JWT 未授权调用工具: ${allowedTool}` } as grpc.ServiceError);
          return;
        }

        (call as AuthenticatedCall).auth = payload;
        handler(call, callback);
      } catch (e: any) {
        callback({ code: grpc.status.UNAUTHENTICATED, message: e?.message ?? "JWT 校验失败" } as grpc.ServiceError);
      }
    };
  };
}
