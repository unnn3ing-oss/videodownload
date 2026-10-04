const INSTALLERS = {
  win: { file: "installers/install-windows.cmd", label: "Windows 安裝檔" },
  mac: { file: "installers/install-mac.zip", label: "Mac 安裝檔" },
};

export function installerFor(os) {
  return INSTALLERS[os] ?? null;
}

export function classifyConnectError(message) {
  const text = String(message ?? "");
  if (text.includes("not found")) return "not_installed";
  if (text.includes("forbidden")) return "forbidden";
  if (text.includes("has exited")) return "exited";
  return "other";
}
