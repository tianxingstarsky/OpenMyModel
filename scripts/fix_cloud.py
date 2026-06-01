with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    c = f.read()

# The $d in Uri.parse was lost, fix all three
old1 = "Uri.parse('http:///admin/keys')"
new1 = "Uri.parse('http://$d/admin/keys')"
c = c.replace(old1, new1)

old2 = "Uri.parse('http:///v1/chat/completions')"
new2 = "Uri.parse('http://$d/v1/chat/completions')"
c = c.replace(old2, new2)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(c)

print("fixed cloud_page.dart")
