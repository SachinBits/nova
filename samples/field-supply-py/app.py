import os


def archive(name):
    os.system("tar czf out.tgz " + name)
    return "done"
