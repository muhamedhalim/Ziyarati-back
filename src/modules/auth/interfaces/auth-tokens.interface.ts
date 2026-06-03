export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // access-token lifetime in seconds
}

export interface AuthResult extends AuthTokens {
  user: {
    id: string;
    tenantId: string | null;
    email?: string | null;
    fullName?: string | null;
    roles: string[];
    permissions: string[];
  };
}
