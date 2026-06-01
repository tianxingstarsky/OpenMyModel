import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import '../services/python_bridge.dart';

/// 内置对话页面 - 流式聊天 + 多模态图片输入

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

  void _sendMessage() async {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty || _isGenerating) return;

    setState(() {
      _messages.add({"role": "user", "content": text});
      _messages.add({"role": "assistant", "content": ""});
      _inputCtrl.clear();
      _isGenerating = true;
      _streamBuffer = "";
    });

    _scrollToBottom();

    try {
      final stream = widget.bridge.chatStream(_messages.where((m) => m["content"].toString().isNotEmpty).toList());
      await for (final chunk in stream) {
        try {
          final data = jsonDecode(chunk);
          final choices = data["choices"] as List?;
          if (choices != null && choices.isNotEmpty) {
            final delta = choices[0]["delta"];
            if (delta != null && delta["content"] != null) {
              _streamBuffer += delta["content"];
              setState(() {
                _messages.last["content"] = _streamBuffer;
              });
              _scrollToBottom();
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      setState(() {
        _messages.last["content"] = "(错误: $e)";
      });
    }

    setState(() => _isGenerating = false);
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
                constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.65),
                decoration: BoxDecoration(
                  color: isUser ? const Color(0xFF00B7C3).withAlpha(40) : ft.Colors.grey.withAlpha(20),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(isUser ? "👤 你" : "🤖 助手", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
                  const SizedBox(height: 4),
                  SelectableText(msg["content"] ?? "",
                    style: TextStyle(color: isUser ? Colors.white : Colors.grey[200])),
                  if (i == _messages.length - 1 && _isGenerating && !isUser)
                    const Padding(padding: EdgeInsets.only(top: 8), child: SizedBox(width: 12, height: 12, child: ft.ProgressRing(strokeWidth: 2))),
                ]),
              ),
            );
          },
        ),
      ),

      // 输入栏
      Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFF16213E),
          border: Border(top: BorderSide(color: Colors.grey[800]!)),
        ),
        child: Row(children: [
          Expanded(
            child: ft.TextBox(
              controller: _inputCtrl,
              placeholder: "输入消息...",
              maxLines: 4,
              minLines: 1,
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          const SizedBox(width: 8),
          ft.IconButton(
            icon: const Icon(ft.FluentIcons.send, size: 20),
            onPressed: _isGenerating ? null : _sendMessage,
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