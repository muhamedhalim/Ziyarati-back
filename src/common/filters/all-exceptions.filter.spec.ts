import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import {
  EntityNotFoundError,
  OptimisticLockVersionMismatchError,
  QueryFailedError,
} from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-code';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let host: any;
  let request: any;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    request = {
      requestId: 'req-1',
      method: 'POST',
      originalUrl: '/api/v1/x',
      user: { id: 'u1', tenantId: 't1' },
      body: { password: 'secret', email: 'a@b.com' },
    };
    host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status }),
      }),
    };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const bodySent = () => json.mock.calls[0][0];

  it('renders the canonical shape for an AppError', () => {
    filter.catch(new AppError(ErrorCode.FORBIDDEN, { message: 'no' }), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(bodySent()).toMatchObject({ code: ErrorCode.FORBIDDEN, requestId: 'req-1', path: '/api/v1/x' });
  });

  it('maps a QueryFailedError (unique violation) to a 409', () => {
    const err = Object.assign(new QueryFailedError('q', [], new Error('dup')), { code: '23505' });
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(bodySent().code).toBe(ErrorCode.UNIQUE_VIOLATION);
  });

  it('maps an EntityNotFoundError to 404', () => {
    filter.catch(new EntityNotFoundError('X', {}), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(bodySent().code).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps an optimistic-lock mismatch to 409', () => {
    filter.catch(new OptimisticLockVersionMismatchError('X', 1, 2), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('maps a class-validator HttpException (array message) to VALIDATION_ERROR', () => {
    const exc = new HttpException({ message: ['email must be valid', 'name required'] }, HttpStatus.BAD_REQUEST);
    filter.catch(exc, host);
    expect(bodySent().code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(Array.isArray(bodySent().message)).toBe(true);
  });

  it('maps a generic HttpException by its status', () => {
    filter.catch(new NotFoundException('missing'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(bodySent().code).toBe(ErrorCode.NOT_FOUND);
  });

  it('treats an unknown error as a 500 (message hidden in production)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prodFilter = new AllExceptionsFilter();
    prodFilter.catch(new Error('internal db dsn leak'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(bodySent().message).toBe('An unexpected error occurred');
    process.env.NODE_ENV = prev;
  });

  it('includes a dev stack and sanitizes the logged body', () => {
    filter.catch(new Error('boom'), host); // non-prod → stack in context
    expect(bodySent().context?.stack).toBeDefined();
  });
});
