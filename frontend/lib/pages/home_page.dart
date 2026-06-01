import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
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

class _HomePageState extends State<HomePage> {
  int _currentIndex = 0;
  final PythonBridge _bridge = PythonBridge();
  final tcServer = TextEditingController();
  final tcFolder = TextEditingController(text: r"F:\llama_cpp\llama-b9253\models");
  final tcModel = TextEditingController();
  final tcMmproj = TextEditingController();
  final tcProfile = TextEditingController();
  final _scrollCtrl = ScrollController();

  List<Map<String, dynamic>> _files = [];
  bool _running = false, _starting = false;
  String _status = "未启动";
  ServerConfig _cfg = ServerConfig();
  List<dynamic> _profiles = [];

  @override
  void initState() {
    super.initState();
    _refresh(); _check(); _loadP();
  }

  void _refresh() => setState(() => _files = LocalFileService.listFiles(tcFolder.text));
  Future _check() async {
    try { final s = await _bridge.getStatus(); if (mounted) setState(() { _running = s["running"]??false; _status = _running?"运行中":"未启动"; }); } catch (_) {}
  }
  Future _loadP() async { try { final p = await _bridge.listProfiles(); if (mounted) setState(() => _profiles = p); } catch (_) {} }

  Future _pickS() async { final r = await FilePicker.platform.pickFiles(dialogTitle:"llama-server.exe",allowedExtensions:["exe"]); if(r!=null&&r.files.single.path!=null) setState(()=>tcServer.text=r.files.single.path!); }
  Future _pickF() async { final r = await FilePicker.platform.getDirectoryPath(dialogTitle:"模型文件夹"); if(r!=null){setState(()=>tcFolder.text=r);_refresh();} }

  Future _start() async {
    if(tcServer.text.isEmpty){_msg("请设置 llama-server.exe 路径");return;}
    if(tcModel.text.isEmpty){_msg("请选模型");return;}
    setState(()=>_starting=true);
    try {
      _cfg.serverPath=tcServer.text; _cfg.modelPath=tcModel.text; _cfg.mmprojPath=tcMmproj.text;
      final ok = await _bridge.startServer(_cfg);
      if(ok){setState((){_running=true;_status="运行中";});_msg("已启动",ok:true);}
    }catch(e){_msg("失败: $e");}
    setState(()=>_starting=false);
  }
  Future _stop() async { await _bridge.stopServer(); setState((){_running=false;_status="已停止";}); }

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
      ft.PaneItem(icon:Icon(ft.FluentIcons.chat),title:Text("对话"),body:ChatPage(bridge:_bridge)),
      ft.PaneItem(icon:Icon(ft.FluentIcons.cloud),title:Text("云端连接"),body:CloudPage()),
    ]));
  }

  Widget _page(List<Map<String,dynamic>> models,List<Map<String,dynamic>> mms) {
    return SingleChildScrollView(controller:_scrollCtrl,padding:EdgeInsets.all(28),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text("OutMyModel",style:TextStyle(fontSize:26,fontWeight:FontWeight.bold)),
      Text("本地算力 / 云端共享",style:TextStyle(fontSize:14,color:Colors.grey[600])),
      SizedBox(height:20),
      // 启动栏
      Row(children:[
        Container(width:12,height:12,decoration:BoxDecoration(color:_running?Colors.green:Colors.grey[400],shape:BoxShape.circle)),
        SizedBox(width:10),
        Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(_running?"运行中":"未启动",style:TextStyle(fontSize:15,fontWeight:FontWeight.w600)),Text(_status,style:TextStyle(fontSize:12,color:Colors.grey[500]))])),
        if(_running) ft.Button(onPressed:_stop,child:Text("停止")) else ft.FilledButton(onPressed:_starting?null:_start,child:Text(_starting?"启动中...":"启动 llama-server")),
      ]),
      SizedBox(height:20),
      _lbl("llama-server.exe"), Row(children:[Expanded(child:ft.TextBox(controller:tcServer,placeholder:"选择 exe")),SizedBox(width:8),ft.Button(onPressed:_pickS,child:Text("浏览"))]),
      SizedBox(height:14),
      _lbl("模型文件夹"), Row(children:[Expanded(child:ft.TextBox(controller:tcFolder,onChanged:(_)=>_refresh())),SizedBox(width:8),ft.Button(onPressed:_pickF,child:Text("浏览"))]),
      SizedBox(height:14),
      _lbl("模型"), _grid(models,tcModel), SizedBox(height:8),
      _lbl("mmproj (可选)"), _grid(mms,tcMmproj),
      SizedBox(height:16),
      // 参数
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

  Widget _params()=>Padding(padding:EdgeInsets.only(top:12),child:Wrap(spacing:14,runSpacing:10,children:[
    _ip("ngl (GPU层)",_cfg.nGpuLayers,(v)=>_cfg.nGpuLayers=v),_ip("c (上下文)",_cfg.contextSize,(v)=>_cfg.contextSize=v),
    _ip("b (批处理)",_cfg.batchSize,(v)=>_cfg.batchSize=v),_ip("ub (微批处理)",_cfg.ubatchSize,(v)=>_cfg.ubatchSize=v),
    _ip("t (线程)",_cfg.threads,(v)=>_cfg.threads=v),_ip("np (槽位)",_cfg.slots,(v)=>_cfg.slots=v),
    _ip("port (端口)",_cfg.port,(v)=>_cfg.port=v),
    _dp("缓存K",_cfg.cacheTypeK,["f16","q8_0","q4_0"],(v)=>_cfg.cacheTypeK=v),
    _dp("缓存V",_cfg.cacheTypeV,["f16","q8_0","q4_0"],(v)=>_cfg.cacheTypeV=v),
    _tp("FlashAttn",_cfg.flashAttn,(v)=>_cfg.flashAttn=v),_tp("mlock",_cfg.mlLock,(v)=>_cfg.mlLock=v),
    _tp("cont-batch",_cfg.contBatching,(v)=>_cfg.contBatching=v),_tp("embeddings",_cfg.embeddings,(v)=>_cfg.embeddings=v),
  ]));
  Widget _ip(String l,int v,Function(int)s)=>SizedBox(width:150,child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(l,style:TextStyle(fontSize:11,color:Colors.grey)),ft.TextBox(controller:TextEditingController(text:v.toString()),onChanged:(x){final n=int.tryParse(x);if(n!=null){s(n);setState((){});}})]));
  Widget _dp(String l,String v,List<String>o,Function(String)s)=>SizedBox(width:150,child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(l,style:TextStyle(fontSize:11,color:Colors.grey)),ft.ComboBox(value:v,items:o.map((x)=>ft.ComboBoxItem(value:x,child:Text(x))).toList(),onChanged:(x){if(x!=null){s(x);setState((){});}})]));
  Widget _tp(String l,bool v,Function(bool)s)=>SizedBox(width:150,child:Row(children:[SizedBox(width:40,child:ft.ToggleSwitch(checked:v,onChanged:(x){s(x);setState((){});})),SizedBox(width:4),Text(l,style:TextStyle(fontSize:11,color:Colors.grey))]));

  Widget _profs()=>Padding(padding:EdgeInsets.only(top:12),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
    if(_profiles.isNotEmpty)Wrap(spacing:6,children:_profiles.map((p)=>ft.Card(padding:EdgeInsets.symmetric(horizontal:10,vertical:4),child:Row(mainAxisSize:MainAxisSize.min,children:[GestureDetector(onTap:()=>_loadPf(p["name"]),child:Text(p["name"],style:TextStyle(fontWeight:FontWeight.w500))),SizedBox(width:6),GestureDetector(onTap:(){_bridge.deleteProfile(p["name"]);_loadP();},child:Icon(Icons.close,size:14,color:Colors.grey))]))).toList()),
    SizedBox(height:8),
    Row(children:[SizedBox(width:150,child:ft.TextBox(controller:tcProfile,placeholder:"档案名")),SizedBox(width:8),ft.Button(onPressed:_savePf,child:Text("保存"))]),
  ]));

  @override
  void dispose(){tcServer.dispose();tcFolder.dispose();tcModel.dispose();tcMmproj.dispose();tcProfile.dispose();_scrollCtrl.dispose();super.dispose();}
}