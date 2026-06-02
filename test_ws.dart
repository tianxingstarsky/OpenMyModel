import "dart:io";
import "dart:convert";

void main() async {
  print("Dart WebSocket test...");
  try {
    var ws = await WebSocket.connect("ws://localhost/ws/node");
    print("1. Connected!");
    ws.add(jsonEncode({"type":"auth","password":"admin123456","nodeId":"test","nodeName":"dart-test","modelName":""}));
    ws.listen((d) {
      var msg = jsonDecode(d);
      print("2. Received: type=${msg["type"]}");
      if (msg["type"] == "auth_ok") {
        print("3. AUTH OK! nodeId=${msg["nodeId"]}");
        ws.close();
      }
    }, onError: (e) { print("ERROR: $e"); }, onDone: () { print("DONE"); });
    await Future.delayed(Duration(seconds: 5));
    print("TIMEOUT");
    ws.close();
  } catch (e) {
    print("FAIL: $e");
  }
}
