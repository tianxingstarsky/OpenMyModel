import 'dart:io';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';
import 'package:file_picker/file_picker.dart';
import '../models/server_config.dart';
import '../services/python_bridge.dart';
import '../services/local_file_service.dart';
import 'chat_page.dart';
import 'cloud_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WindowListener {
  int _currentIndex = 0;
  Timer? _pollTimer;
  final PythonBridge _bridge = PythonBridge();
  final tcServer = TextEditingController();
  final tcFolder = TextEditingController();
  final tcModel = TextEditingController();
  final tcMmproj = TextEditingController();
  final tcProfile = TextEditingController();
  final _scrollCtrl = ScrollController();

  List<Map<String, dynamic>> _files = [];
  bool _running = false, _starting = false, _bridgeReady = false;
  String _status = "检查中...";
  ServerConfig _cfg = ServerConfig();
  List<dynamic> _profiles = [];
  Process? _bridgeProcess;

  // 保持页面存活
  final _chatKey = GlobalKey<ChatPageState>();

  @override
  void initState() {
    super.initState();
    _loadPrefs();
    _refresh();
    _startBridge();
    _loadP();
    _startPolling();
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final sp = prefs.getString("server_path");
    final mf = prefs.getString("model_folder");
    if (mounted) setState(() {
      if (sp != null && sp.isNotEmpty) tcServer.text = sp;
      if (mf != null && mf.isNotEmpty) tcFolder.text = mf;
    });
  }


  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString("server_path", tcServer.text);
    await prefs.setString("model_folder", tcFolder.text);
  }

  Future<void> _startBridge() async {
    try {
      final pythonPath = r"C:\Users\tianx\.conda\envs\myenv\python.exe";
      final scriptPath = r"F:\llama_cpp\output_my_model\python\bridge_server.py";
      _bridgeProcess = await Process.start(pythonPath, [scriptPath], workingDirectory: r"F:\llama_cpp\output_my_model");
      await Future.delayed(const Duration(seconds: 3));
      await _check();
      setState(() => _bridgeReady = true);
    } catch (e) {
      setState(() { _status = "桥接启动失败: $e"; _bridgeReady = false; });
    }
  }

  void _refresh() => setState(() => _files = LocalFileService.listFiles(tcFolder.text));

  Future _check() async {
    try {
      final s = await _bridge.getStatus();
      if (mounted) setState(() {
        _running = s["running"] ?? false;
        _status = _running ? "运行中 - ${s["model"] ?? ""}" : "已就绪，选择模型后启动";
      });
    } catch (_) {
      if (mounted) setState(() { _running = false; _status = "桥接未就绪"; });
    }
  }

  /// 实时轮询 llama-server 状态（每3秒）
  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) => _check());
  }
  Future _loadP() async { try { final p = await _bridge.listProfiles(); if (mounted) setState(() => _profiles = p); } catch (_) {} }

  Future _pickS() async { final r = await FilePicker.platform.pickFiles(dialogTitle:"llama-server.exe",allowedExtensions:["exe"]); if(r!=null&&r.files.single.path!=null) setState(()=>tcServer.text=r.files.single.path!); _savePrefs(); }
  Future _pickF() async { final r = await FilePicker.platform.getDirectoryPath(dialogTitle:"模型文件夹"); if(r!=null){setState(()=>tcFolder.text=r);_refresh();_savePrefs();} }

  Future _start() async {
    if(tcServer.text.isEmpty){_msg("请设置 llama-server.exe 路径");return;}
    if(tcModel.text.isEmpty){_msg("请选模型");return;}
    if(!_bridgeReady){_msg("桥接服务未就绪，请稍候");return;}
    setState(()=>_starting=true);
    try {
      _cfg.serverPath=tcServer.text; _cfg.modelPath=tcModel.text; _cfg.mmprojPath=tcMmproj.text;
      final ok = await _bridge.startServer(_cfg);
      if(ok){setState((){_running=true;_status="运行中 - ${tcModel.text.split("\\").last}";});_msg("已启动",ok:true);}
    }catch(e){_msg("启动失败: $e");}
    setState(()=>_starting=false);
  }
  Future _stop() async { await _bridge.stopServer(); setState((){_running=false;_status="已停止";});_check(); }

  Future _savePf() async {
    final n = tcProfile.text.trim(); if(n.isEmpty)return;
    _cfg.serverPath=tcServer.text; _cfg.modelPath=tcModel.text; _cfg.mmprojPath=tcMmproj.text;
    await _bridge.saveProfile(n,_cfg); tcProfile.clear(); _loadP();
  }
  Future _loadPf(String n) async {
    final c = await _bridge.loadProfile(n); if(c!=null&&mounted){setState((){_cfg=c; tcModel.text=c.modelPath; tcMmproj.text=c.mmprojPath;});}
  }

  void _msg(String m,{bool ok=false}){if(!mounted)return;ft.displayInfoBar(context,builder:(c,cl)=>ft.InfoBar(title:Text(m),severity:ok?ft.InfoBarSeverity.success:ft.InfoBarSeverity.warning));}

  @override
  Widget build(BuildContext ctx) {
    final models = _files.where((f)=>!f["name"].toString().startsWith("mmproj")).toList();
    final mms = _files.where((f)=>f["name"].toString().startsWith("mmproj")).toList();
    return ft.NavigationView(pane:ft.NavigationPane(selected:_currentIndex,onChanged:(i)=>setState(()=>_currentIndex=i),displayMode:ft.PaneDisplayMode.compact,items:[
      ft.PaneItem(icon:Icon(ft.FluentIcons.home),title:Text("首页"),body:_page(models,mms)),
      ft.PaneItem(icon:Icon(ft.FluentIcons.chat),title:Text("对话"),body: ChatPage(key:_chatKey,bridge:_bridge)),
      ft.PaneItem(
        icon: Icon(ft.FluentIcons.cloud),
        title: Text("云端连接"),
        body: CloudPage(
          llamaUrl: "http://127.0.0.1:${_cfg.port}",
          modelName: _running ? tcModel.text.split("\\").last : "",
          serverRunning: _running,
        ),
      ),
    ]));
  }

  Widget _page(List<Map<String,dynamic>> models,List<Map<String,dynamic>> mms) {
    return SingleChildScrollView(controller:_scrollCtrl,padding:EdgeInsets.all(28),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text("OpenMyModel",style:TextStyle(fontSize:26,fontWeight:FontWeight.bold)),
      Text("本地算力 / 云端共享",style:TextStyle(fontSize:14,color:Colors.grey[600])),
      SizedBox(height:20),
      Row(children:[
        Container(width:12,height:12,decoration:BoxDecoration(color:_running?Colors.green:_bridgeReady?Colors.orange:Colors.grey,shape:BoxShape.circle)),
        SizedBox(width:10),
        Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(_running?"运行中":"未启动",style:TextStyle(fontSize:15,fontWeight:FontWeight.w600)),Text(_status,style:TextStyle(fontSize:12,color:Colors.grey[500]))])),
        SizedBox(width:8),
        if(!_bridgeReady)
          ft.FilledButton(onPressed:null,child:Text("桥接启动中..."))
        else if(_running)
          ft.Button(onPressed:_stop,child:Text("停止"))
        else
          ft.FilledButton(onPressed:_starting?null:_start,child:Text(_starting?"启动中...":"启动 llama-server")),
      ]),
      SizedBox(height:20),
      _lbl("llama-server.exe"), Row(children:[Expanded(child:ft.TextBox(controller:tcServer,placeholder:"选择 exe")),SizedBox(width:8),ft.Button(onPressed:_pickS,child:Text("浏览"))]),
      SizedBox(height:14),
      _lbl("模型文件夹"), Row(children:[Expanded(child:ft.TextBox(controller:tcFolder,onChanged:(_)=>_refresh())),SizedBox(width:8),ft.Button(onPressed:_pickF,child:Text("浏览"))]),
      SizedBox(height:14),
      _lbl("模型"), _grid(models,tcModel), SizedBox(height:8),
      _lbl("mmproj (可选)"), _grid(mms,tcMmproj),
      SizedBox(height:16),
      ft.Expander(header:Text("推理参数",style:TextStyle(fontWeight:FontWeight.w600,fontSize:14)),content:_params(),initiallyExpanded:false),
      SizedBox(height:8),
      ft.Expander(header:Text("配置档案",style:TextStyle(fontWeight:FontWeight.w600,fontSize:14)),content:_profs(),initiallyExpanded:false),
      SizedBox(height:40),
    ]));
  }

  Widget _lbl(String t)=>Padding(padding:EdgeInsets.only(bottom:4),child:Text(t,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600)));
  Widget _grid(List<Map<String,dynamic>> files,TextEditingController ctrl){
    if(files.isEmpty)return Text("暂无",style:TextStyle(color:Colors.grey[400],fontSize:12));
    return Wrap(spacing:6,runSpacing:6,children:files.map((f){
      final n=f["name"] as String; final gb=((f["size"]??0)/1024/1024/1024).toStringAsFixed(1); final sel=ctrl.text==f["path"];
      return GestureDetector(onTap:()=>setState(()=>ctrl.text=f["path"]??""),child:ft.Card(padding:EdgeInsets.symmetric(horizontal:10,vertical:6),backgroundColor:sel?Color(0xFF0078D4).withAlpha(20):null,child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(n,style:TextStyle(fontSize:12,fontWeight:sel?FontWeight.bold:FontWeight.normal)),Text("$gb GB",style:TextStyle(fontSize:10,color:Colors.grey[500]))])));
    }).toList());
  }

  Widget _params()=>Padding(padding:EdgeInsets.only(top:12),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
    _section("核心参数"),SizedBox(height:10),
    _num("--n-gpu-layers","GPU 层数","加载到 GPU 的模型层数，-1=全部加载到显存",_cfg.nGpuLayers,(v)=>setState(()=>_cfg.nGpuLayers=v)),
    _num("--ctx-size","上下文长度","模型最大上下文窗口，如 32768/128000",_cfg.contextSize,(v)=>setState(()=>_cfg.contextSize=v)),
    _num("--batch-size","批处理大小","并行处理的 token 数量，影响吞吐量",_cfg.batchSize,(v)=>setState(()=>_cfg.batchSize=v)),
    _num("--ubatch-size","微批处理","单次推理的最小批次，一般为 batch/4",_cfg.ubatchSize,(v)=>setState(()=>_cfg.ubatchSize=v)),
    _num("--threads","CPU 线程数","推理使用的 CPU 线程，0=自动检测",_cfg.threads,(v)=>setState(()=>_cfg.threads=v)),
    _num("--parallel","并行槽位","同时处理的最大并发请求数",_cfg.slots,(v)=>setState(()=>_cfg.slots=v)),
    _num("--port","服务端口","llama-server HTTP 监听端口",_cfg.port,(v)=>setState(()=>_cfg.port=v)),
    SizedBox(height:16), _section("缓存量化"),SizedBox(height:10),
    _choice("--cache-type-k","K 缓存量化","Key 缓存的量化精度，q8_0 推荐",_cfg.cacheTypeK,["f16","q8_0","q4_0"],(v)=>setState(()=>_cfg.cacheTypeK=v)),
    _choice("--cache-type-v","V 缓存量化","Value 缓存的量化精度，q8_0 推荐",_cfg.cacheTypeV,["f16","q8_0","q4_0"],(v)=>setState(()=>_cfg.cacheTypeV=v)),
    SizedBox(height:16), _section("功能开关"),SizedBox(height:10),
    _bool("--flash-attn","Flash Attention","启用 FA 加速推理，减少显存占用",_cfg.flashAttn,(v)=>setState(()=>_cfg.flashAttn=v)),
    _bool("--mlock","内存锁定","锁定模型到物理内存，防止 swap 影响性能",_cfg.mlLock,(v)=>setState(()=>_cfg.mlLock=v)),
    _bool("--cont-batching","连续批处理","动态合并请求，提高吞吐量",_cfg.contBatching,(v)=>setState(()=>_cfg.contBatching=v)),
    _bool("--embeddings","嵌入模式","启用文本嵌入提取功能",_cfg.embeddings,(v)=>setState(()=>_cfg.embeddings=v)),
    SizedBox(height:8),
    ft.Expander(header:Text("高级参数",style:TextStyle(fontSize:12,color:Colors.grey[600])),content:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      SizedBox(height:10),
      _num("--rope-freq-base","RoPE 基础频率","位置编码基准频率，0=自动",_cfg.ropeFreqBase.toInt(),(v)=>setState(()=>_cfg.ropeFreqBase=v.toDouble())),
      _num("--rope-freq-scale","RoPE 缩放","位置编码缩放因子，用于扩展上下文",_cfg.ropeFreqScale.toInt(),(v)=>setState(()=>_cfg.ropeFreqScale=v.toDouble())),
      _num("--yarn-ext-factor","YaRN 扩展因子","NTK 感知外推的扩展系数",_cfg.yarnExtFactor.toInt(),(v)=>setState(()=>_cfg.yarnExtFactor=v.toDouble())),
      _num("--yarn-attn-factor","YaRN 注意力因子","注意力分配的缩放比例",_cfg.yarnAttnFactor.toInt(),(v)=>setState(()=>_cfg.yarnAttnFactor=v.toDouble())),
      _bool("--no-kv-offload","禁用 KV 卸载","强制 KV 缓存留在显存",_cfg.noKvOffload,(v)=>setState(()=>_cfg.noKvOffload=v)),
      _bool("--no-mmap","禁用 mmap","不使用内存映射加载模型",_cfg.noMmap,(v)=>setState(()=>_cfg.noMmap=v)),
      SizedBox(height:8),
      _section("额外启动参数"),SizedBox(height:6),
      SizedBox(width:400,child:ft.TextBox(placeholder:"其他 llama-server 命令行参数",onChanged:(v)=>_cfg.extraArgs=v)),
    ]),initiallyExpanded:false),
  ]));

  Widget _num(String flag,String name,String desc,int value,Function(int) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600))]),SizedBox(height:4),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600])),SizedBox(height:6),SizedBox(width:200,child:ft.TextBox(controller:TextEditingController(text:value.toString()),onChanged:(x){final n=int.tryParse(x);if(n!=null)onChanged(n);}))]))));
  Widget _choice(String flag,String name,String desc,String value,List<String> options,Function(String) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600))]),SizedBox(height:4),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600])),SizedBox(height:6),SizedBox(width:200,child:ft.ComboBox(value:value,items:options.map((o)=>ft.ComboBoxItem(value:o,child:Text(o))).toList(),onChanged:(x){if(x!=null)onChanged(x);}))]))));
  Widget _bool(String flag,String name,String desc,bool value,Function(bool) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600)),Spacer(),ft.ToggleSwitch(checked:value,onChanged:(v){onChanged(v);})]),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600]))]))));
  Widget _section(String t)=>Text(t,style:TextStyle(fontSize:14,fontWeight:FontWeight.w600));

  Widget _profs()=>Padding(padding:EdgeInsets.only(top:12),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
    if(_profiles.isNotEmpty)Wrap(spacing:6,children:_profiles.map((p)=>ft.Card(padding:EdgeInsets.symmetric(horizontal:10,vertical:4),child:Row(mainAxisSize:MainAxisSize.min,children:[GestureDetector(onTap:()=>_loadPf(p["name"]),child:Text(p["name"],style:TextStyle(fontWeight:FontWeight.w500))),SizedBox(width:6),GestureDetector(onTap:(){_bridge.deleteProfile(p["name"]);_loadP();},child:Icon(Icons.close,size:14,color:Colors.grey))]))).toList()),
    SizedBox(height:8),
    Row(children:[SizedBox(width:150,child:ft.TextBox(controller:tcProfile,placeholder:"档案名")),SizedBox(width:8),ft.Button(onPressed:_savePf,child:Text("保存"))]),
  ]));

  @override
  void dispose(){
    _pollTimer?.cancel();
    tcServer.dispose();tcFolder.dispose();tcModel.dispose();tcMmproj.dispose();tcProfile.dispose();_scrollCtrl.dispose();
    _bridgeProcess?.kill(); _bridgeProcess = null;
    super.dispose();
  }
}