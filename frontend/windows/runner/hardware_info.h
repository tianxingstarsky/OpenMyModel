#ifndef RUNNER_HARDWARE_INFO_H_
#define RUNNER_HARDWARE_INFO_H_

#include <flutter/encodable_value.h>

// Reads the Windows display adapter inventory without starting an inference engine.
// Failures are represented as status=unknown instead of escaping into the runner.
flutter::EncodableMap GetGpuInfo();

#endif  // RUNNER_HARDWARE_INFO_H_
