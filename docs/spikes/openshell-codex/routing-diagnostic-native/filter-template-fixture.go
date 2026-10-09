package main
import("bytes";"fmt";"text/template")
func main(){
  const expression=`{{range .Config.Env}}{{if and (ge (len .) 9) (eq (slice . 0 9) "RUST_LOG=")}}R{{end}}{{if eq . "OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"}}L{{end}}{{end}}`
  t:=template.Must(template.New("finite-markers").Parse(expression))
  cases:=[]struct{env []string;want string}{
    {[]string{"X=x","OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"},"L"},
    {[]string{"RUST_LOG=","OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"},"RL"},
    {[]string{"RUST_LOG=PRIVATE-value","OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"},"RL"},
    {[]string{"OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug","OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"},"LL"},
    {[]string{"HOME=/","PRIVATE=private-body"},""},
    {[]string{"OPENSHELL_LOG_LEVEL=debug"},""},
  }
  for _,c:=range cases{var b bytes.Buffer;v:=struct{Config struct{Env []string}}{};v.Config.Env=c.env;if err:=t.Execute(&b,v);err!=nil{panic("template execution failed")};if b.String()!=c.want{panic("finite marker mismatch")}}
  fmt.Println("6 finite Go-template fixtures passed; no environment values emitted")
}
