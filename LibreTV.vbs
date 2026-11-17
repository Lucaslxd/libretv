Option Explicit

Dim fso, root, sh, port, url, i, ready

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8080"
url = "http://127.0.0.1:" & port & "/"
Set sh = CreateObject("WScript.Shell")

ready = IsUp(url & "api/status")

If Not ready Then
  If fso.FileExists(root & "\start-server.bat") Then
    sh.CurrentDirectory = root
    sh.Run "cmd /c """ & root & "\start-server.bat""", 0, False
  End If
  For i = 1 To 60
    WScript.Sleep 500
    If IsUp(url & "api/status") Then
      ready = True
      Exit For
    End If
  Next
End If

sh.Run url, 1, False

If Not ready Then
  MsgBox "LibreTV server did not respond on " & url & vbCrLf & vbCrLf & _
         "Please check:" & vbCrLf & root & "\logs\server.log" & vbCrLf & _
         "or run start-server.bat in that folder to see the error.", _
         48, "LibreTV"
End If

Function IsUp(u)
  Dim h
  IsUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.XMLHTTP")
  h.Open "GET", u, False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then IsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
