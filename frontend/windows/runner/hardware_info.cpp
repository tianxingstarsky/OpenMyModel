#include "hardware_info.h"

#include <windows.h>
#include <dxgi.h>
#include <d3dkmthk.h>
#include <wrl/client.h>

#include <cstdint>
#include <exception>
#include <sstream>
#include <string>
#include <utility>

namespace {

using flutter::EncodableList;
using flutter::EncodableMap;
using flutter::EncodableValue;
using Microsoft::WRL::ComPtr;

EncodableMap GpuResult(EncodableList devices, const std::string& status,
                      const std::string& error = {}) {
  EncodableMap result = {
      {EncodableValue("devices"), EncodableValue(std::move(devices))},
      {EncodableValue("status"), EncodableValue(status)},
      {EncodableValue("source"), EncodableValue("windows-dxgi")},
  };
  if (!error.empty()) {
    result.emplace(EncodableValue("error"), EncodableValue(error));
  }
  return result;
}

EncodableMap SystemFailure(const char* operation, LONG result,
                           const char* code_type = "HRESULT") {
  std::ostringstream message;
  message << operation << " failed (" << code_type << " 0x" << std::hex
          << std::uppercase << static_cast<uint32_t>(result) << ")";
  return GpuResult({}, "unknown", message.str());
}

NTSTATUS ReadAdapterType(const LUID& luid, D3DKMT_ADAPTERTYPE* type) {
  D3DKMT_OPENADAPTERFROMLUID opened = {};
  opened.AdapterLuid = luid;
  const NTSTATUS status = D3DKMTOpenAdapterFromLuid(&opened);
  if (status < 0) {
    return status;
  }
  D3DKMT_QUERYADAPTERINFO query = {};
  query.hAdapter = opened.hAdapter;
  query.Type = KMTQAITYPE_ADAPTERTYPE;
  query.pPrivateDriverData = type;
  query.PrivateDriverDataSize = sizeof(*type);
  const NTSTATUS queried = D3DKMTQueryAdapterInfo(&query);
  D3DKMT_CLOSEADAPTER closed = {};
  closed.hAdapter = opened.hAdapter;
  D3DKMTCloseAdapter(&closed);
  return queried;
}

bool AdapterName(const DXGI_ADAPTER_DESC1& descriptor, std::string* name) {
  // Keep the conversion inside the fixed-size Windows buffer even if a driver
  // returns a description without a terminating zero.
  int length = 0;
  while (length < 128 && descriptor.Description[length] != L'\0') {
    ++length;
  }
  if (length == 0) {
    *name = "Unknown graphics adapter";
    return true;
  }
  const int bytes = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, descriptor.Description, length, nullptr, 0,
      nullptr, nullptr);
  if (bytes == 0) {
    return false;
  }
  name->resize(static_cast<size_t>(bytes));
  return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                            descriptor.Description, length, name->data(), bytes,
                            nullptr, nullptr) == bytes;
}

EncodableMap ReadGpuInfo() {
  ComPtr<IDXGIFactory1> factory;
  const HRESULT created = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
  if (FAILED(created)) {
    return SystemFailure("CreateDXGIFactory1", created);
  }

  EncodableList devices;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT enumerated = factory->EnumAdapters1(index, &adapter);
    if (enumerated == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    if (FAILED(enumerated)) {
      return SystemFailure("EnumAdapters1", enumerated);
    }

    DXGI_ADAPTER_DESC1 descriptor = {};
    const HRESULT described = adapter->GetDesc1(&descriptor);
    if (FAILED(described)) {
      return SystemFailure("GetDesc1", described);
    }
    if ((descriptor.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0) {
      continue;
    }
    // Remote-display drivers can expose an extra DXGI adapter with the real
    // GPU's name and memory but no render engine (for example an IddCx device).
    // Check the Windows adapter type instead of merging GPUs with equal names.
    D3DKMT_ADAPTERTYPE type = {};
    const NTSTATUS classified = ReadAdapterType(descriptor.AdapterLuid, &type);
    if (classified < 0) {
      return SystemFailure("D3DKMT adapter type query", classified, "NTSTATUS");
    }
    if (type.SoftwareDevice || type.IndirectDisplayDevice) {
      continue;
    }

    std::string name;
    if (!AdapterName(descriptor, &name)) {
      return GpuResult({}, "unknown", "Could not decode the GPU description");
    }
    EncodableMap device = {
        {EncodableValue("name"), EncodableValue(std::move(name))},
        {EncodableValue("backend"), EncodableValue("dxgi")},
    };
    // DedicatedVideoMemory is SIZE_T, not the 32-bit AdapterRAM value from WMI.
    // SharedSystemMemory is not VRAM and must never inflate this capacity.
    constexpr uint64_t bytes_per_mib = 1024ULL * 1024ULL;
    const int64_t total_mib = static_cast<int64_t>(
        descriptor.DedicatedVideoMemory / bytes_per_mib);
    if (total_mib > 0) {
      device.emplace(EncodableValue("totalMemoryMiB"), EncodableValue(total_mib));
    }
    devices.emplace_back(std::move(device));
  }

  const std::string status = devices.empty() ? "cpu_only" : "detected";
  return GpuResult(std::move(devices), status);
}

}  // namespace

flutter::EncodableMap GetGpuInfo() {
  try {
    return ReadGpuInfo();
  } catch (const std::exception&) {
    return GpuResult({}, "unknown", "Windows GPU detection failed");
  } catch (...) {
    return GpuResult({}, "unknown", "Windows GPU detection failed");
  }
}
