export interface OAuthProvider {
  id: string;
  name: string;
  authEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
}

export interface OAuthFlowConfig {
  provider: string;
  scopes: string[];
}
