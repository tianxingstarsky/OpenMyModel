import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:file_picker/file_picker.dart';
import '../services/python_bridge.dart';

/// 对话页 - 流式聊天 + 多图上传

class ChatPage extends StatefulWidget {
  final PythonBridge bridge;
  const ChatPage({super.key, required this.bridge});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final List<Map<String, dynamic>> _messages = [];
  final TextEditingController _inputCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  bool _isGenerating = false;
  String _streamBuffer = "";
  List<String> _pendingImages = []; // base64 encoded images

  void _sendMessage() async {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty && _pendingImages.isEmpty) return;
    if (_isGenerating) return;

    // 构建消息内容
    final content = <Map<String, dynamic>>[];
    for (final img in _pendingImages) {
      content.add({"type": "image_url", "image_url": {"url": "data:image/png;base64,$img"}});
    }
    if (text.isNotEmpty) {
      content.add({"type": "text", "text": text});
    }

    setState(() {
      _messages.add({"role": "user", "content": _pendingImages.isEmpty ? text : content, "images": List.from(_pendingImages)});
      _messages.add({"role": "assistant", "content": ""});
      _inputCtrl.clear();
      _pendingImages = [];
      _isGenerating = true;
      _streamBuffer = "";
    });

    _scrollToBottom();

    try {
      final msgs = _messages
          .where((m) => m["role"] != "assistant" || m["content"].toString().isNotEmpty)
          .map((m) {
            // 对于用户消息，转换 images 为实际内容
            if (m["role"] == "user") {
              final c = m["content"];
              if (c is String) return {"role": "user", "content": c};
              return {"role": "user", "content": c};
            }
            return {"role": m["role"], "content": m["content"]};
          })
          .toList();

      final stream = widget.bridge.chatStream(msgs);
      await for (final chunk in stream) {
        try {
          final data = jsonDecode(chunk);
          final choices = data["choices"] as List?;
          if (choices != null && choices.isNotEmpty) {
            final delta = choices[0]["delta"];
            if (delta != null && delta["content"] != null) {
              _streamBuffer += delta["content"];
              if (mounted) {
                setState(() { _messages.last["content"] = _streamBuffer; });
                _scrollToBottom();
              }
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      if (mounted) {
        setState(() { _messages.last["content"] = "(llama-server 未启动或未响应)"; });
      }
    }

    if (mounted) setState(() => _isGenerating = false);
  }

  Future<void> _pickImages() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.image,
      allowMultiple: true,
      dialogTitle: "选择图片 (可多选)",
    );
    if (result != null && result.files.isNotEmpty) {
      final images = <String>[];
      for (final file in result.files) {
        if (file.path != null) {
          final bytes = await File(file.path!).readAsBytes();
          images.add(base64Encode(bytes));
        }
      }
      setState(() => _pendingImages.addAll(images));
    }
  }

  void _scrollToBottom() {
    Future.delayed(const Duration(milliseconds: 50), () {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent,
            duration: const Duration(milliseconds: 100), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      // 消息列表
      Expanded(
        child: ListView.builder(
          controller: _scrollCtrl,
          padding: const EdgeInsets.all(16),
          itemCount: _messages.length,
          itemBuilder: (ctx, i) {
            final msg = _messages[i];
            final isUser = msg["role"] == "user";
            return Align(
              alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
              child: Container(
                margin: const EdgeInsets.symmetric(vertical: 4),
                padding: const EdgeInsets.all(12),
                constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.7),
                decoration: BoxDecoration(
                  color: isUser ? const Color(0xFF0078D4).withAlpha(20) : Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: isUser ? const Color(0xFF0078D4).withAlpha(40) : Colors.grey[200]!),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  // 用户图片
                  if (isUser && msg["images"] != null)
                    ...((msg["images"] as List).map((img) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(base64Decode(img), width: 120, height: 120, fit: BoxFit.cover)),
                    ))),
                  Text(isUser ? "你" : "助手", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                  const SizedBox(height: 4),
                  Text(
                    isUser ? (msg["content"] is String ? msg["content"] : (msg["content"] as List).where((c) => c["type"] == "text").map((c) => c["text"]).join(" ")) : msg["content"] ?? "",
                    style: const TextStyle(color: Color(0xFF333333)),
                  ),
                  if (i == _messages.length - 1 && _isGenerating && !isUser)
                    const Padding(padding: EdgeInsets.only(top: 8), child: SizedBox(width: 14, height: 14, child: ft.ProgressRing(strokeWidth: 2))),
                ]),
              ),
            );
          },
        ),
      ),

      // 待发送图片预览
      if (_pendingImages.isNotEmpty)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          color: const Color(0xFFF0F0F0),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: _pendingImages.asMap().entries.map((e) => Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Stack(children: [
                ClipRRect(borderRadius: BorderRadius.circular(6), child: Image.memory(base64Decode(e.value), width: 60, height: 60, fit: BoxFit.cover)),
                Positioned(top: -4, right: -4, child: GestureDetector(
                  onTap: () => setState(() => _pendingImages.removeAt(e.key)),
                  child: Container(decoration: const BoxDecoration(color: Colors.red, shape: BoxShape.circle), child: const Icon(Icons.close, size: 16, color: Colors.white)),
                )),
              ]),
            )).toList()),
          ),
        ),

      // 输入栏
      Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: Colors.grey[200]!)),
        ),
        child: Row(children: [
          // 图片按钮
          ft.IconButton(
            icon: const Icon(ft.FluentIcons.picture, size: 20, color: Color(0xFF555555)),
            onPressed: _pickImages,
            ),
          const SizedBox(width: 4),
          Expanded(
            child: ft.TextBox(
              controller: _inputCtrl,
              placeholder: "输入消息...",
              maxLines: 3,
              minLines: 1,
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          const SizedBox(width: 8),
          // 发送按钮
          Container(
            decoration: BoxDecoration(
              color: _isGenerating ? Colors.grey[300] : const Color(0xFF0078D4),
              borderRadius: BorderRadius.circular(6),
            ),
            child: ft.IconButton(
              icon: Icon(ft.FluentIcons.send, size: 20, color: _isGenerating ? Colors.grey : Colors.white),
              onPressed: _isGenerating ? null : _sendMessage,
            ),
          ),
        ]),
      ),
    ]);
  }

  @override
  void dispose() {
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }
}