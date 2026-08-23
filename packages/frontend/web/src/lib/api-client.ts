import { hcWithType } from "@laizhixingxingdeli/server/hc";

const apiClient = hcWithType("/api", {
  init: { credentials: "include" },
});

export default apiClient;
