# Fast File Picker

## Features
- support search file using relavtive path like './src/hello.h'
- support search file using absolute path like '/(project_root_path)/src/hello.h'
- support pick from recently opened files
- support multiple workspace folders

## How to use
Hit `Ctrl + Shirft + P` and input 'FilePicker', you'll see:
```
> FilePicker: Search Files
> FilePicker: Build Search Database
```

## Steps:
- Exclude certain directories that you don't want them to be scanned in the follow up step (optional)
- Built the search database (mandatory, one time)    
   note:  
   1. you have to manually execute this command, because this would take a few seconds for a large project, like the [AOSP](https://source.android.com/) project;
   2. when files changed a lot in the workspace, files deleted/renamed/added, you might want to re-execute this command again, because the feature of watching files changes and re-indexing them aren't implemented yet, 0_0||.
- Search for files
That's it!

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/how-to-use-fast-file-picker.gif">    


## Screenshot
<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/file-picker-commands.png">    

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/exclude_dirs.png">


## Bugs
Visit https://github.com/wwm0609/quickfilepicker/ and file an issue

----------------------------------------------------------------------------

## TODO
- follow symbolic links during build search database
- display file type icon in quick pick view
- supprot sychronize certain directoies after file changes
- run tests on windows 

## How To Run Locally
Clone this project into your local disk and open it in vscode, press F5, there you go!
