import { assertType, describe, it } from "vitest";
describe("ApiReferenceConfiguration", () => {
  it("ensure we are generating correct types for preferredSecurityScheme", () => {
    assertType({ preferredSecurityScheme: "apiKey" });
    assertType({ preferredSecurityScheme: ["apiKey", "bearerAuth"] });
    assertType({
      preferredSecurityScheme: ["apiKey", ["basic", "oauth2"], ["apiKey", "bearerAuth", "oauth2"]]
    });
    assertType({
      // @ts-expect-error incorrect type
      preferredSecurityScheme: 47
    });
    assertType({
      // @ts-expect-error incorrect type
      preferredSecurityScheme: [22, null]
    });
  });
  it("ensure we are generating correct types for securitySchemes", () => {
    assertType({
      securitySchemes: {
        apiKey: { type: "apiKey", name: "api_key", in: "header" }
      }
    });
    assertType({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
      }
    });
    assertType({
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            implicit: { scopes: { "read:items": "Read access to items" } },
            password: {
              username: "username",
              password: "password"
            }
          }
        }
      }
    });
  });
});
//# sourceMappingURL=authentication-configuration.test-d.js.map
