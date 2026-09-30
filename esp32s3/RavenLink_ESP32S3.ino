#include <WiFi.h>
#include <WebSocketsServer.h>
#include "USB.h"
#include "USBHIDMouse.h"

// RavenLink ESP32-S3
// Receives compact JSON aim-delta packets over WebSocket and exposes them as USB HID mouse movement.
// Arduino-ESP32 target: ESP32-S3 with USB CDC On Boot disabled when HID is used as the native USB device.

static const char* AP_SSID = "RavenLink-S3";
static const char* AP_PASS = "ravenengine";
static const uint16_t WS_PORT = 7878;

WebSocketsServer ws(WS_PORT);
USBHIDMouse mouse;

uint32_t packetCount = 0;
uint32_t lastPacketMs = 0;
uint32_t lastTelemetryMs = 0;
int16_t lastDx = 0;
int16_t lastDy = 0;
bool aimActive = false;

int readIntField(const String& json, const char* field, int fallback = 0) {
  String key = String("\"") + field + "\":";
  int start = json.indexOf(key);
  if (start < 0) return fallback;
  start += key.length();
  while (start < (int)json.length() && json[start] == ' ') start++;
  int end = start;
  if (end < (int)json.length() && json[end] == '-') end++;
  while (end < (int)json.length() && isDigit(json[end])) end++;
  return json.substring(start, end).toInt();
}

bool readBoolField(const String& json, const char* field, bool fallback = false) {
  String key = String("\"") + field + "\":";
  int start = json.indexOf(key);
  if (start < 0) return fallback;
  start += key.length();
  while (start < (int)json.length() && json[start] == ' ') start++;
  if (json.startsWith("true", start)) return true;
  if (json.startsWith("false", start)) return false;
  return fallback;
}

String readRawNumberField(const String& json, const char* field) {
  String key = String("\"") + field + "\":";
  int start = json.indexOf(key);
  if (start < 0) return "0";
  start += key.length();
  while (start < (int)json.length() && json[start] == ' ') start++;
  int end = start;
  while (end < (int)json.length() && (isDigit(json[end]) || json[end] == '.' || json[end] == '-')) end++;
  return json.substring(start, end);
}

void sendHello(uint8_t client) {
  String msg = "{\"type\":\"hello\",\"device\":\"ESP32-S3\",\"name\":\"RavenLink\",\"protocol\":1,\"ip\":\"";
  msg += WiFi.softAPIP().toString();
  msg += "\"}";
  ws.sendTXT(client, msg);
}

void sendTelemetry(uint8_t client) {
  String msg = "{\"type\":\"telemetry\",\"packets\":" + String(packetCount) +
               ",\"lastPacketMs\":" + String(lastPacketMs) +
               ",\"dx\":" + String(lastDx) +
               ",\"dy\":" + String(lastDy) +
               ",\"active\":" + String(aimActive ? "true" : "false") +
               ",\"rssi\":" + String(WiFi.RSSI()) + "}";
  ws.sendTXT(client, msg);
}

void handleText(uint8_t client, const String& msg) {
  if (msg.indexOf("\"type\":\"ping\"") >= 0) {
    String t = readRawNumberField(msg, "t");
    ws.sendTXT(client, "{\"type\":\"pong\",\"t\":" + t + "}");
    return;
  }

  if (msg.indexOf("\"type\":\"aim\"") >= 0) {
    int dx = constrain(readIntField(msg, "dx", 0), -127, 127);
    int dy = constrain(readIntField(msg, "dy", 0), -127, 127);
    bool active = readBoolField(msg, "active", false);

    lastDx = (int16_t)dx;
    lastDy = (int16_t)dy;
    aimActive = active;
    packetCount++;
    lastPacketMs = millis();

    if (active && (dx != 0 || dy != 0)) {
      mouse.move((int8_t)dx, (int8_t)dy, 0);
    }
    return;
  }

  if (msg.indexOf("\"type\":\"telemetry\"") >= 0) {
    sendTelemetry(client);
  }
}

void onWsEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      sendHello(client);
      break;
    case WStype_TEXT:
      handleText(client, String((char*)payload).substring(0, length));
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(250);

  mouse.begin();
  USB.begin();

  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  WiFi.softAP(AP_SSID, AP_PASS, 6, false, 4);

  ws.begin();
  ws.onEvent(onWsEvent);

  Serial.println();
  Serial.println("RavenLink ESP32-S3 ready");
  Serial.print("AP: "); Serial.println(AP_SSID);
  Serial.print("IP: "); Serial.println(WiFi.softAPIP());
  Serial.print("WebSocket: ws://"); Serial.print(WiFi.softAPIP()); Serial.print(":"); Serial.print(WS_PORT); Serial.println("/ws");
}

void loop() {
  ws.loop();

  const uint32_t t = millis();
  if (aimActive && t - lastPacketMs > 250) {
    aimActive = false; // failsafe: stop output if Raven disappears
  }

  if (t - lastTelemetryMs > 1000) {
    lastTelemetryMs = t;
    ws.broadcastTXT(
      "{\"type\":\"telemetry\",\"packets\":" + String(packetCount) +
      ",\"active\":" + String(aimActive ? "true" : "false") + "}"
    );
  }

  delay(1);
}
