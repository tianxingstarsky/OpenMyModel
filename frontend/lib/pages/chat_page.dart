import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:file_picker/file_picker.dart';
import '../services/python_bridge.dart';

class ChatPage extends StatefulWidget {
  final PythonBridge bridge;
  const ChatPage({super.key, required this.bridge});
  @override
  State<ChatPage> createState() => ChatPageState();
}

class _ImageAttachment {
  final Uint8List bytes;
  final String mime;
  late final String dataUrl = 'data:$mime;base64,${base64Encode(bytes)}';
  _ImageAttachment(this.bytes, this.mime);
}

class ChatPageState extends State<ChatPage> {
  final List<Map<String, dynamic>> _messages = [];
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  bool _isGenerating = false;
  bool _stopping = false;
  bool _picking = false;
  bool _scrollScheduled = false;
  String? _error;
  List<_ImageAttachment> _pendingImages = [];

  Future<void> _send() async {
    final text = _inputCtrl.text.trim();
    if (_isGenerating || _picking || (text.isEmpty && _pendingImages.isEmpty))
      return;
    final images = List<_ImageAttachment>.from(_pendingImages);
    final content = <Map<String, dynamic>>[
      for (final image in images)
        {
          'type': 'image_url',
          'image_url': {'url': image.dataUrl},
        },
      if (text.isNotEmpty) {'type': 'text', 'text': text},
    ];
    final assistant = <String, dynamic>{
      'role': 'assistant',
      'content': '',
      'reasoning': '',
    };
    setState(() {
      _messages.add({
        'role': 'user',
        'content': images.isEmpty ? text : content,
        'text': text,
        'images': images,
      });
      _messages.add(assistant);
      _inputCtrl.clear();
      _pendingImages = [];
      _isGenerating = true;
      _stopping = false;
      _error = null;
    });
    _scroll(force: true);
    final history = _messages
        .where(
          (message) =>
              !identical(message, assistant) &&
              (message['role'] == 'user' ||
                  message['content'].toString().isNotEmpty),
        )
        .map(
          (message) => <String, dynamic>{
            'role': message['role'],
            'content': message['content'],
          },
        )
        .toList();
    try {
      await for (final chunk in widget.bridge.chatStream(history)) {
        if (!mounted || _stopping) break;
        final data = jsonDecode(chunk);
        if (data is! Map) throw BridgeException('无效的模型响应');
        if (data['error'] != null) {
          final error = data['error'];
          throw BridgeException(
            (error is Map ? error['message'] ?? error : error).toString(),
          );
        }
        final choices = data['choices'];
        if (choices is List && choices.isNotEmpty) {
          final delta = choices.first['delta'];
          if (delta is Map) {
            setState(() {
              if (delta['content'] is String)
                assistant['content'] += delta['content'];
              if (delta['reasoning_content'] is String)
                assistant['reasoning'] += delta['reasoning_content'];
            });
            _scroll();
          }
        }
      }
      if (mounted &&
          !_stopping &&
          assistant['content'] == '' &&
          assistant['reasoning'] == '') {
        setState(() => _error = '模型返回了空响应，请检查模型状态和配置');
      }
    } catch (error) {
      if (mounted && !_stopping) setState(() => _error = error.toString());
    } finally {
      if (mounted)
        setState(() {
          _isGenerating = false;
          _stopping = false;
        });
    }
  }

  void _stop() {
    if (!_isGenerating || _stopping) return;
    setState(() => _stopping = true);
    widget.bridge.cancelChat();
  }

  Future<void> _pickImages() async {
    if (_picking || _isGenerating) return;
    setState(() => _picking = true);
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        allowMultiple: true,
        dialogTitle: '选择图片（最多 4 张，每张 5 MB）',
      );
      if (!mounted || result == null) return;
      if (_pendingImages.length + result.files.length > 4)
        throw BridgeException('每条消息最多添加 4 张图片');
      final attachments = <_ImageAttachment>[];
      for (final file in result.files) {
        if (file.size > 5 * 1024 * 1024)
          throw BridgeException('${file.name} 超过 5 MB');
        final bytes =
            file.bytes ??
            (file.path == null ? null : await File(file.path!).readAsBytes());
        if (bytes == null || bytes.length > 5 * 1024 * 1024)
          throw BridgeException('无法读取图片或图片超过 5 MB');
        final extension = file.extension?.toLowerCase();
        final mime = extension == 'jpg' || extension == 'jpeg'
            ? 'image/jpeg'
            : 'image/${extension ?? 'png'}';
        attachments.add(_ImageAttachment(bytes, mime));
      }
      if (mounted)
        setState(() {
          _pendingImages.addAll(attachments);
          _error = null;
        });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  void _scroll({bool force = false}) {
    if (_scrollScheduled ||
        (!force &&
            _scrollCtrl.hasClients &&
            _scrollCtrl.position.extentAfter > 160))
      return;
    _scrollScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollScheduled = false;
      if (mounted && _scrollCtrl.hasClients)
        _scrollCtrl.jumpTo(_scrollCtrl.position.maxScrollExtent);
    });
  }

  Future<void> _clear() async {
    final confirmed = await ft.showDialog<bool>(
      context: context,
      builder: (context) => ft.ContentDialog(
        title: const Text('清空当前对话？'),
        content: const Text('当前会话中的消息会被清除，无法恢复。'),
        actions: [
          ft.Button(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          ft.FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('清空'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted)
      setState(() {
        _messages.clear();
        _error = null;
      });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: Row(
            children: [
              const Text(
                '本地对话',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              ft.Button(
                onPressed: _isGenerating || _messages.isEmpty ? null : _clear,
                child: const Text('清空对话'),
              ),
            ],
          ),
        ),
        Expanded(
          child: _messages.isEmpty
              ? const Center(
                  child: Text(
                    '先在首页启动模型，再输入消息开始对话。\n聊天记录在本次应用会话内保留。',
                    textAlign: TextAlign.center,
                  ),
                )
              : ListView.builder(
                  controller: _scrollCtrl,
                  padding: const EdgeInsets.all(16),
                  itemCount: _messages.length,
                  itemBuilder: (context, index) {
                    final message = _messages[index];
                    final isUser = message['role'] == 'user';
                    final images =
                        message['images'] as List<_ImageAttachment>? ?? [];
                    final content = isUser
                        ? message['text'] as String
                        : message['content'] as String;
                    final reasoning = message['reasoning'] as String? ?? '';
                    final generating =
                        !isUser &&
                        index == _messages.length - 1 &&
                        _isGenerating;
                    return Align(
                      alignment: isUser
                          ? Alignment.centerRight
                          : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.symmetric(vertical: 6),
                        padding: const EdgeInsets.all(14),
                        constraints: BoxConstraints(
                          maxWidth: MediaQuery.sizeOf(context).width * 0.72,
                        ),
                        decoration: BoxDecoration(
                          color: isUser
                              ? const Color(0xFFEAF3FB)
                              : Colors.white,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: const Color(0xFFE1E5EA)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              isUser ? '你' : '助手',
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.grey,
                              ),
                            ),
                            if (images.isNotEmpty)
                              Wrap(
                                spacing: 8,
                                children: images
                                    .map(
                                      (image) => Image.memory(
                                        image.bytes,
                                        width: 120,
                                        height: 100,
                                        fit: BoxFit.cover,
                                        errorBuilder: (_, error, stack) =>
                                            const Text('图片无法预览'),
                                      ),
                                    )
                                    .toList(),
                              ),
                            if (reasoning.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: ft.Expander(
                                  header: const Text('思考过程'),
                                  content: SelectableText(reasoning),
                                  initiallyExpanded: false,
                                ),
                              ),
                            const SizedBox(height: 6),
                            SelectableText(
                              content.isEmpty
                                  ? (generating
                                        ? (_stopping ? '正在停止…' : '正在生成…')
                                        : (reasoning.isNotEmpty
                                              ? '思考过程已接收'
                                              : '未收到内容'))
                                  : content,
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: ft.InfoBar(
              title: const Text('对话失败'),
              content: Text(_error!),
              severity: ft.InfoBarSeverity.error,
              onClose: () => setState(() => _error = null),
            ),
          ),
        if (_pendingImages.isNotEmpty)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Wrap(
              spacing: 8,
              children: _pendingImages
                  .asMap()
                  .entries
                  .map(
                    (entry) => SizedBox(
                      width: 100,
                      child: Column(
                        children: [
                          Image.memory(
                            entry.value.bytes,
                            width: 80,
                            height: 64,
                            fit: BoxFit.cover,
                            errorBuilder: (_, error, stack) =>
                                const Text('无法预览'),
                          ),
                          ft.HyperlinkButton(
                            onPressed: _isGenerating
                                ? null
                                : () => setState(
                                    () => _pendingImages.removeAt(entry.key),
                                  ),
                            child: const Text('移除'),
                          ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              ft.Tooltip(
                message: '添加图片（最多 4 张，每张 5 MB）',
                child: ft.IconButton(
                  icon: const Icon(ft.FluentIcons.picture),
                  onPressed: _isGenerating || _picking ? null : _pickImages,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ft.TextBox(
                  controller: _inputCtrl,
                  placeholder: '输入消息…',
                  maxLines: 4,
                  minLines: 1,
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              if (_isGenerating)
                ft.Button(
                  onPressed: _stopping ? null : _stop,
                  child: Text(_stopping ? '停止中…' : '停止生成'),
                )
              else
                ft.FilledButton(
                  onPressed: _picking ? null : _send,
                  child: const Text('发送'),
                ),
            ],
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    _stopping = true;
    widget.bridge.cancelChat();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }
}
