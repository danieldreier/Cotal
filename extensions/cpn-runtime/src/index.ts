/** CPN runtime extension. Importing it registers the `cpn` manager runtime. */
export {
  CpnRuntime,
  HttpCpnLaunchClient,
  cpnRuntimeProvider,
  configureCpnLauncher,
  loadCpnRuntimeConfig,
  type CpnLaunchClient,
  type CpnLaunchRequest,
  type CpnLaunchReceipt,
  type CpnJobStatus,
  type CpnProfile,
  type CpnRuntimeConfig,
  type CpnTaskClass,
} from "./runtime.js";
