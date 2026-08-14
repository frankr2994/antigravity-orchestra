Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The template path is the directory where this script is located
$templatePath = $PSScriptRoot

# Create the main form
$form = New-Object System.Windows.Forms.Form
$form.Text = "Antigravity Tri-Agent Manager"
$form.Size = New-Object System.Drawing.Size(450,230)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

# Title Label
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(20,20)
$label.Size = New-Object System.Drawing.Size(400,20)
$label.Text = "Legacy installer — use Start-Orchestra.ps1 for the dashboard:"
$form.Controls.Add($label)

# Folder Path TextBox
$txtFolder = New-Object System.Windows.Forms.TextBox
$txtFolder.Location = New-Object System.Drawing.Point(20,45)
$txtFolder.Size = New-Object System.Drawing.Size(300,20)
$form.Controls.Add($txtFolder)

# Browse Button
$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Location = New-Object System.Drawing.Point(330,43)
$btnBrowse.Size = New-Object System.Drawing.Size(80,24)
$btnBrowse.Text = "Browse..."
$btnBrowse.Add_Click({
    $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
    $folderBrowser.Description = "Select the target project folder"
    if ($folderBrowser.ShowDialog() -eq "OK") {
        $txtFolder.Text = $folderBrowser.SelectedPath
    }
})
$form.Controls.Add($btnBrowse)

# Install Button
$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Location = New-Object System.Drawing.Point(20,90)
$btnInstall.Size = New-Object System.Drawing.Size(390,40)
$btnInstall.Text = "Initialize Tri-Agent Setup"
$btnInstall.Font = New-Object System.Drawing.Font("Arial", 10, [System.Drawing.FontStyle]::Bold)
$btnInstall.BackColor = [System.Drawing.Color]::LightGreen
$btnInstall.Add_Click({
    $targetDir = $txtFolder.Text
    if ([string]::IsNullOrWhiteSpace($targetDir) -or !(Test-Path $targetDir)) {
        [System.Windows.Forms.MessageBox]::Show("Please select a valid directory first.", "Error", 0, [System.Windows.Forms.MessageBoxIcon]::Warning)
        return
    }

    try {
        $resolvedTarget = (Resolve-Path -LiteralPath $targetDir -ErrorAction Stop).Path
        $managedEntries = @('AGENTS.md', '.agents', '.codex')
        $existingEntries = @($managedEntries | Where-Object { Test-Path -LiteralPath (Join-Path $resolvedTarget $_) })
        if ($existingEntries.Count -gt 0) {
            [System.Windows.Forms.MessageBox]::Show("The target already contains Orchestra-managed files:`n`n$($existingEntries -join ', ')`n`nNothing was overwritten. Use the dashboard project onboarding flow so conflicts are backed up safely.", "Existing setup detected", 0, [System.Windows.Forms.MessageBoxIcon]::Warning)
            return
        }

        # This legacy installer only initializes projects without an existing setup.
        if (Test-Path -LiteralPath (Join-Path $templatePath 'AGENTS.md')) { Copy-Item -LiteralPath (Join-Path $templatePath 'AGENTS.md') -Destination $resolvedTarget }
        if (Test-Path -LiteralPath (Join-Path $templatePath '.agents')) { Copy-Item -LiteralPath (Join-Path $templatePath '.agents') -Destination $resolvedTarget -Recurse }
        if (Test-Path -LiteralPath (Join-Path $templatePath '.codex')) { Copy-Item -LiteralPath (Join-Path $templatePath '.codex') -Destination $resolvedTarget -Recurse }

        [System.Windows.Forms.MessageBox]::Show("Success! The legacy Tri-Agent files were installed into:`n`n$targetDir`n`nFor project-scoped chat and automatic onboarding, launch Start-Orchestra.ps1 instead.", "Success", 0, [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("An error occurred while copying files:`n$_", "Error", 0, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
})
$form.Controls.Add($btnInstall)

# Show the GUI
[void]$form.ShowDialog()
