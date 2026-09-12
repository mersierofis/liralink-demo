import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiError } from '../api-error';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { statusCode, message, error } = this.toApiError(exception);
    if (statusCode >= 500) {
      this.logger.error(
        message,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    response
      .status(statusCode)
      .json({ statusCode, message, error } satisfies ApiError);
  }

  private toApiError(exception: unknown): ApiError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { statusCode: status, message: body };
      }
      const { message, error } = body as {
        message?: string | string[];
        error?: string;
      };
      return {
        statusCode: status,
        message: Array.isArray(message)
          ? message.join('; ')
          : (message ?? exception.message),
        error,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
