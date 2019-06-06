# Quick File Picker

# How to use
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

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/resources/dark/how-to-use-fast-file-picker.gif">    


## Screenshot
<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/resources/dark/file-picker-commands.png">    

<img src="https://raw.githubusercontent.com/wwm0609/quickfilepicker/master/resources/dark/exclude_dirs.png">

# TODO
- follow symbolic links during build search database
- display file type icon in quick pick view
- supprot sychronize certain directoies after file changes

# How To Run Locally
Clone this project into your local disk and open it in vscode, press F5, there you go!

# Bugs
Visit https://github.com/wwm0609/quickfilepicker/ and file an issue
